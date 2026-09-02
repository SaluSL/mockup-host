import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/lib/password.js";

// The hash goes to stdout and the prompt to stderr, so
// `npm run hash-password > hash.txt` captures only the value. The password is
// never an argv parameter: that would land in shell history and the process list.
const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question("Password: ");
rl.close();

if (password.length < 12) {
  console.error("Refusing to hash a password shorter than 12 characters.");
  process.exit(1);
}

process.stdout.write(`${await hashPassword(password)}\n`);
