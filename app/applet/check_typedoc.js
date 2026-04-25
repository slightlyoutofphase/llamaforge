const fs = require("node:fs");
const path = require("node:path");

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat?.isDirectory()) {
      results = results.concat(walk(filePath));
    } else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      results.push(filePath);
    }
  });
  return results;
}

const files = walk("./src");
let missingDocCount = 0;

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^export (async )?(function|const|interface|type|class) /)) {
      let hasDoc = false;
      let j = i - 1;

      while (j >= 0) {
        if (lines[j].trim() === "" || lines[j].trim().startsWith("//")) {
          // skip empty lines or line comments
          j--;
        } else if (lines[j].trim() === "*/" || lines[j].trim().endsWith("*/")) {
          hasDoc = true;
          break;
        } else {
          break;
        }
      }

      if (!hasDoc) {
        console.log(`${file}:${i + 1}: Missing TypeDoc for "${line.trim()}"`);
        missingDocCount++;
      }
    }
  }
}

console.log(`Found ${missingDocCount} missing TypeDoc comments.`);
