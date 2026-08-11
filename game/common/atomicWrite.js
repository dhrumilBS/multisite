// Shared atomic JSON write: write to a .tmp sibling then rename over the
// destination, so a crash mid-write never leaves a corrupt/partial file.
"use strict";

const fs = require("fs");

function writeJsonAtomic(destPath, data) {
  const tmp = destPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, destPath);
}

module.exports = { writeJsonAtomic };
