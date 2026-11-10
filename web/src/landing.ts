import "./styles.css";
import { initNav } from "./common";
initNav();

// Pricing page: show today's prices as set by MAIZ (the HTML holds the launch prices as a fallback).
const priced = document.querySelectorAll<HTMLElement>("[data-price]");
if (priced.length) {
  void import("./api").then(({ api }) => api<{ prices?: Record<string, number> }>("/store")).then((r) => {
    if (!r.ok || !r.data?.prices) return;
    priced.forEach((el) => {
      const v = r.data!.prices![el.dataset.price!];
      if (typeof v === "number") el.textContent = `£${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
    });
  });
}
