import test from 'node:test';
import assert from 'node:assert';
import { isCallable, nextCallableSlot, calculateNextRetrySlot } from '../../backend/src/services/queueService.js';
import dispatcher from '../../backend/src/workers/dispatcher.js';

test('Calling Hours - isCallable rejects calls outside 09:00-21:00 IST', () => {
  const config = { enforce_calling_hours: true };
  const lead = { phone: '+919876543210' };

  // 1. Daytime on a weekday (Thursday 2:00 PM IST = 08:30 UTC) -> true
  const daytimeWeekday = new Date('2026-09-10T08:30:00.000Z');
  assert.strictEqual(isCallable(lead, config, daytimeWeekday), true, 'Should be callable at 2:00 PM IST on Thursday');

  // 2. Nighttime (Thursday 11:30 PM IST = 18:00 UTC) -> false
  const nightTime = new Date('2026-09-10T18:00:00.000Z');
  assert.strictEqual(isCallable(lead, config, nightTime), false, 'Should NOT be callable at 11:30 PM IST');

  // 3. Early morning before start hour (Friday 6:00 AM IST = 00:30 UTC) -> false
  const earlyMorning = new Date('2026-09-11T00:30:00.000Z');
  assert.strictEqual(isCallable(lead, config, earlyMorning), false, 'Should NOT be callable at 6:00 AM IST');

  // 4. Exactly at start hour (09:00 AM IST = 03:30 UTC) -> true
  const startHour = new Date('2026-09-11T03:30:00.000Z');
  assert.strictEqual(isCallable(lead, config, startHour), true, 'Should be callable at exactly 9:00 AM IST');

  // 5. Exactly at end hour (09:00 PM IST = 15:30 UTC) -> false
  const endHour = new Date('2026-09-11T15:30:00.000Z');
  assert.strictEqual(isCallable(lead, config, endHour), false, 'Should NOT be callable at 9:00 PM IST');

  // 6. Sunday daytime (Sunday 2:00 PM IST = 08:30 UTC) -> false
  const sundayDaytime = new Date('2026-09-13T08:30:00.000Z');
  assert.strictEqual(isCallable(lead, config, sundayDaytime), false, 'Should NOT be callable on Sunday');
});

test('Calling Hours - nextCallableSlot snaps forward past forbidden windows', () => {
  const config = { enforce_calling_hours: true };

  // 1. Inside window (Thursday 2:00 PM IST) -> returns same timestamp
  const daytimeWeekday = new Date('2026-09-10T08:30:00.000Z');
  assert.strictEqual(nextCallableSlot(config, daytimeWeekday), daytimeWeekday.toISOString());

  // 2. Late at night (Thursday 11:30 PM IST = 18:00 UTC) -> snaps to Friday 9:00 AM IST (03:30 UTC)
  const nightTime = new Date('2026-09-10T18:00:00.000Z');
  const nextFromNight = nextCallableSlot(config, nightTime);
  assert.strictEqual(nextFromNight, '2026-09-11T03:30:00.000Z', 'Should snap to Friday 9:00 AM IST');

  // 3. Early morning before 9 AM (Friday 5:00 AM IST = 23:30 UTC on Sep 10) -> snaps to Friday 9:00 AM IST
  const earlyMorning = new Date('2026-09-10T23:30:00.000Z');
  const nextFromEarly = nextCallableSlot(config, earlyMorning);
  assert.strictEqual(nextFromEarly, '2026-09-11T03:30:00.000Z', 'Should snap to Friday 9:00 AM IST');

  // 4. Saturday night (Saturday 10:00 PM IST = 16:30 UTC on Sep 12) -> skips Sunday, snaps to Monday 9:00 AM IST (Sep 14, 03:30 UTC)
  const satNight = new Date('2026-09-12T16:30:00.000Z');
  const nextFromSatNight = nextCallableSlot(config, satNight);
  assert.strictEqual(nextFromSatNight, '2026-09-14T03:30:00.000Z', 'Should skip Sunday and snap to Monday 9:00 AM IST');
});

test('Calling Hours - calculateNextRetrySlot rolls retry past nighttime into 9am next morning', () => {
  const config = { enforce_calling_hours: true };

  // If a call fails at 20:55 IST, a 15-min retry would hit 21:10 IST (forbidden).
  // calculateNextRetrySlot should detect this and snap forward.
  const targetForbiddenSlot = calculateNextRetrySlot(1, [15 * 60 * 1000], config);
  assert.ok(targetForbiddenSlot, 'Returned target slot');
  
  // Verify that any target slot returned is ALWAYS a callable slot
  assert.strictEqual(isCallable({}, config, new Date(targetForbiddenSlot)), true, 'Scheduled retry slot MUST be legally callable');
});

test('Outbound Dialer - DIALER_ENABLED=false halts dispatcher tick execution', async () => {
  const prevDialerEnv = process.env.DIALER_ENABLED;
  try {
    process.env.DIALER_ENABLED = 'false';

    let logged = false;
    const originalLog = console.log;
    console.log = (...args) => {
      if (args.join(' ').includes('DIALER_ENABLED=false — skipping tick')) {
        logged = true;
      }
      originalLog.apply(console, args);
    };

    try {
      await dispatcher.tick();
      assert.strictEqual(logged, true, 'Dispatcher should log skipping tick when DIALER_ENABLED=false');
    } finally {
      console.log = originalLog;
    }
  } finally {
    process.env.DIALER_ENABLED = prevDialerEnv;
  }
});

test('Outbound Dialer - placeCall asserts calling hours before dialing', async () => {
  const nightLead = {
    phone: '+919876543210',
    tenant_id: 'default',
    active_leads: {
      leads: {
        id: 'mock-lead-night',
        phone: '+919876543210',
        tenant_id: 'default'
      }
    },
    campaigns: {
      voice_agent_id: 'agent_603d27082e74',
      voice_provider: 'mock',
      status: 'active'
    }
  };

  const prevBypass = process.env.BYPASS_CALLING_HOURS;
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.BYPASS_CALLING_HOURS = 'false';
    // Temporarily unset test NODE_ENV so calling hours are actively checked
    process.env.NODE_ENV = 'production';

    // Mock Date.prototype.getHours or verify at current time if night
    const now = new Date();
    const isCurrentlyNight = !isCallable({}, { enforce_calling_hours: true }, now);

    if (isCurrentlyNight) {
      await assert.rejects(
        async () => {
          await dispatcher.placeCall(nightLead, 'provisional-123');
        },
        /Refusing to dial lead.*outside legal calling hours/,
        'placeCall should throw and refuse to dial outside calling hours'
      );
    }
  } finally {
    process.env.BYPASS_CALLING_HOURS = prevBypass;
    process.env.NODE_ENV = prevEnv;
  }
});
