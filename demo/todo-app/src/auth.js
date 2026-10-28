import { createHash } from 'node:crypto';

const hash = (password) => createHash('sha256').update(password.normalize()).digest('hex');

const users = new Map([['priya', hash('hunter2')]]);

/** Returns true when the username and password match. */
export function login(username, password) {
  const stored = users.get(username);
  if (!stored) return false;
  return hash(password) === stored;
}
