// Writes docs/META-APP-REVIEW.md from the permission list in code, so what we submit to Meta, what the connect screen
// says and what the code asks for are one list. Run: npm run docs:meta. A test fails if the committed file is stale.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaReviewDoc } from "../src/modules/meta-clients/review-doc.js";

writeFileSync(join(import.meta.dirname, "../docs/META-APP-REVIEW.md"), metaReviewDoc());
console.log("wrote docs/META-APP-REVIEW.md");
