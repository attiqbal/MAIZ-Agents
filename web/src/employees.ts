import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";

initNav();
// Each employee card gets its full job description, from the same data the employee works to.
document.querySelectorAll<HTMLElement>("[data-jd]").forEach((card) => {
  const jd = getJobDescription(card.dataset.jd ?? "");
  if (!jd) return;
  const d = document.createElement("details");
  d.className = "jd";
  d.innerHTML = `<summary>Full job description</summary>${jdHtml(jd)}`;
  card.append(d);
});
