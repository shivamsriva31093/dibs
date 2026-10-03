export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

const seed: User[] = [
  { id: "u1", name: "Ada Lovelace", email: "ada@example.com", createdAt: "2026-01-04T09:00:00Z" },
  { id: "u2", name: "Grace Hopper", email: "grace@example.com", createdAt: "2026-02-11T14:30:00Z" },
  { id: "u3", name: "Katherine Johnson", email: "katherine@example.com", createdAt: "2026-03-20T08:15:00Z" },
];

export const db = {
  users: new Map<string, User>(seed.map((user) => [user.id, user])),
};
