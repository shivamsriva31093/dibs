import { db, type User } from "./client.ts";

export function findUser(id: string): User | null {
  return db.users.get(id) ?? null;
}

export function listUsers(): User[] {
  return [...db.users.values()];
}
