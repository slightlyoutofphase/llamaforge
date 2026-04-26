/**
 * @packageDocumentation
 * Simple SQLite primary key behavior demonstration for Bun's sqlite binding.
 */

import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run(`
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    role TEXT
  );
`);

const id = "123";

db.prepare("INSERT INTO messages (id, role) VALUES (?, ?)").run(id, "user");

try {
  db.prepare("INSERT INTO messages (id, role) VALUES (?, ?)").run(id, "assistant");
  console.log("SUCCESS?! How?");
} catch (e: any) {
  console.log(`FAILED as expected: ${e.message}`);
}
