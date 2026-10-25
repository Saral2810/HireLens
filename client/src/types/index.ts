export type Role = 'superadmin' | 'candidate';

export interface User {
  id: string;
  email: string;
  role: Role;
}
