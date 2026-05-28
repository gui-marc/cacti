import fs from "node:fs";
import path from "node:path";

const RUNTIME_DIR = path.resolve(__dirname, "../../../runtime");

if (fs.existsSync(RUNTIME_DIR)) {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  console.log(`removed ${RUNTIME_DIR}`);
}
console.log("Run 'docker-compose down -v' to stop and remove ledger containers");
