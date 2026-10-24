import http from 'http';
import app from '../../backend/src/app.js';
import db from '../../backend/src/config/db.js';

async function runBenchmark() {
  await db.clearDb();

  const server = http.createServer(app);
  const port = await new Promise((resolve) => {
    server.listen(0, () => {
      resolve(server.address().port);
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Starting performance benchmark on ${baseUrl}...`);

  const numRequests = 50;
  const ingestLatencies = [];
  const instantCallLatencies = [];
  let ingestSuccess = 0;
  let ingestFail = 0;
  let callSuccess = 0;
  let callFail = 0;
  const leadIds = [];

  console.log(`\n--- PHASE 1: Concurrent Ingestion of ${numRequests} Leads ---`);
  const ingestStart = Date.now();
  const ingestPromises = Array.from({ length: numRequests }).map(async (_, idx) => {
    // Avoid phone numbers containing 0000 or 403 to bypass DNC mock blocks
    const phoneNum = `+9198765${11111 + idx}`;
    const payload = {
      tenant_id: 'perf-tenant',
      name: `Perf User ${idx}`,
      phone: phoneNum,
      source: 'paid_ads',
      raw_data: { age: 25, city: 'Delhi', income: 400000 }
    };

    const startReq = Date.now();
    try {
      const response = await fetch(`${baseUrl}/leads/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const endReq = Date.now();
      ingestLatencies.push(endReq - startReq);

      if (response.status === 201) {
        const body = await response.json();
        leadIds.push(body.lead.id);
        ingestSuccess++;
      } else {
        ingestFail++;
      }
    } catch (err) {
      ingestFail++;
    }
  });

  await Promise.all(ingestPromises);
  const ingestEnd = Date.now();

  console.log(`\n--- PHASE 2: Concurrent Dispatch of ${leadIds.length} Instant Call Requests ---`);
  const callStart = Date.now();
  const callPromises = leadIds.map(async (leadId) => {
    const payload = {
      tenant_id: 'perf-tenant',
      lead_id: leadId
    };

    const startReq = Date.now();
    try {
      const response = await fetch(`${baseUrl}/leads/calls/instant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const endReq = Date.now();
      instantCallLatencies.push(endReq - startReq);

      if (response.status === 200) {
        callSuccess++;
      } else {
        callFail++;
      }
    } catch (err) {
      callFail++;
    }
  });

  await Promise.all(callPromises);
  const callEnd = Date.now();

  server.close();

  // Calculate Ingestion Stats
  ingestLatencies.sort((a, b) => a - b);
  const ingestDuration = ingestEnd - ingestStart;
  const ingestRps = (numRequests / (ingestDuration / 1000)).toFixed(2);
  const ingestMean = (ingestLatencies.reduce((acc, val) => acc + val, 0) / ingestLatencies.length).toFixed(2);
  const ingestP50 = ingestLatencies[Math.floor(ingestLatencies.length * 0.50)] || 0;
  const ingestP90 = ingestLatencies[Math.floor(ingestLatencies.length * 0.90)] || 0;
  const ingestP99 = ingestLatencies[Math.floor(ingestLatencies.length * 0.99)] || 0;

  // Calculate Instant Call Stats
  instantCallLatencies.sort((a, b) => a - b);
  const callDuration = callEnd - callStart;
  const callRps = (leadIds.length / (callDuration / 1000)).toFixed(2);
  const callMean = (instantCallLatencies.reduce((acc, val) => acc + val, 0) / instantCallLatencies.length).toFixed(2);
  const callP50 = instantCallLatencies[Math.floor(instantCallLatencies.length * 0.50)] || 0;
  const callP90 = instantCallLatencies[Math.floor(instantCallLatencies.length * 0.90)] || 0;
  const callP99 = instantCallLatencies[Math.floor(instantCallLatencies.length * 0.99)] || 0;

  console.log(`\n================ PERFORMANCE RESULTS: INGESTION ================`);
  console.log(`Total Ingestion Requests Run : ${numRequests}`);
  console.log(`Total Time Taken             : ${ingestDuration} ms`);
  console.log(`Throughput                   : ${ingestRps} req/sec`);
  console.log(`Success Rate                 : ${((ingestSuccess / numRequests) * 100).toFixed(2)}%`);
  console.log(`Failure Rate                 : ${((ingestFail / numRequests) * 100).toFixed(2)}%`);
  console.log(`---------------- Latencies ----------------`);
  console.log(`Mean Latency                 : ${ingestMean} ms`);
  console.log(`p50 (Median) Latency          : ${ingestP50} ms`);
  console.log(`p90 Latency                  : ${ingestP90} ms`);
  console.log(`p99 Latency                  : ${ingestP99} ms`);

  console.log(`\n================ PERFORMANCE RESULTS: INSTANT CALLS ================`);
  console.log(`Total Call Requests Run      : ${leadIds.length}`);
  console.log(`Total Time Taken             : ${callDuration} ms`);
  console.log(`Throughput                   : ${callRps} req/sec`);
  console.log(`Success Rate                 : ${((callSuccess / leadIds.length) * 100).toFixed(2)}%`);
  console.log(`Failure Rate                 : ${((callFail / leadIds.length) * 100).toFixed(2)}%`);
  console.log(`---------------- Latencies ----------------`);
  console.log(`Mean Latency                 : ${callMean} ms`);
  console.log(`p50 (Median) Latency          : ${callP50} ms`);
  console.log(`p90 Latency                  : ${callP90} ms`);
  console.log(`p99 Latency                  : ${callP99} ms`);
  console.log(`====================================================================\n`);

  if (callP99 < 1000) {
    console.log(`✅ Performance check passed: p99 latency for instant calls (${callP99}ms) is below 1s.`);
  } else {
    console.warn(`⚠️ Performance warning: p99 latency for instant calls (${callP99}ms) exceeds the target of 1s.`);
  }
  process.exit(0);
}

runBenchmark().catch(err => {
  console.error('Performance benchmark failed to run:', err);
  process.exit(1);
});
