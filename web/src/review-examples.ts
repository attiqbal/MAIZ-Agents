// Example specialised tasks, shown when the API is not running (or has nothing yet), so the client's
// Tasks screen and the platform owner's review queue tell the same story.
import type { TaskProposal } from "../../src/modules/workforce/signoff";

export interface ExampleTask {
  id: string;
  clientName: string;
  /** Hours since it joined the review queue. */
  ageHours: number;
  proposal: TaskProposal;
}

export const EXAMPLE_TASKS: ExampleTask[] = [
  {
    id: "eg-brand-kit", clientName: "Kestrel Coffee", ageHours: 3,
    proposal: {
      title: "Brand kit for the autumn range", employee: "Brand and content creator", days: 5,
      brief: [
        { label: "Who you sell to", value: "Home coffee drinkers, 25 to 45, UK (from the setup form)" },
        { label: "Tone of voice", value: "Warm, plain, playful (read from the website)" },
        { label: "What competitors do", value: "Two local roasters use dark, premium packaging; none use illustration" },
        { label: "Colours and logos already in use", value: "Deep green and cream, kestrel logo" },
        { label: "Goal for this work", value: "Stand out on the shelf in two local delis before Christmas" },
      ],
      design: "One brand kit shown on a bag label, a social post and an email header, so it can be judged in real use.",
      directions: [
        { key: "refresh", name: "Refresh", summary: "Keep the kestrel logo, add an autumn palette and one new typeface. Fastest, and existing customers will recognise it. Recommended.", recommended: true },
        { key: "illustrated", name: "Illustrated", summary: "Keep the logo and add hand-drawn illustrations for each blend. Stands out from both competitors, needs more approval rounds." },
        { key: "rebrand", name: "Full rebrand", summary: "New logo, palette and type. Biggest change, and old packaging would need replacing." },
      ],
      plan: [{ title: "Three sample layouts in the chosen direction", energy: 300 }, { title: "Palette, type and logo rules", energy: 250 }, { title: "Templates: label, post, email header", energy: 400 }],
    },
  },
  {
    id: "eg-handbook", clientName: "Kestrel Coffee", ageHours: 26,
    proposal: {
      title: "Staff handbook, first edition", employee: "People, policy and operations consultant", days: 7,
      brief: [
        { label: "Country and number of staff", value: "United Kingdom, 4 staff (from the setup form)" },
        { label: "Working hours and holiday allowance", value: "Mon to Sat, 28 days including bank holidays" },
        { label: "Existing contracts", value: "2 contracts read from the uploads" },
      ],
      design: "A short, plain-language handbook built from the contracts and the UK minimum requirements, with each policy marked required or recommended.",
      directions: [
        { key: "essentials", name: "Essentials", summary: "Only the policies UK law requires for a team of 4, about 12 pages. Recommended.", recommended: true },
        { key: "full", name: "Full handbook", summary: "Required policies plus recommended ones such as remote work and training, about 30 pages." },
      ],
      plan: [{ title: "Outline and list of policies", energy: 150 }, { title: "Draft all policies", energy: 600 }, { title: "Compliance manager review", energy: 120 }],
    },
  },
  {
    id: "eg-pitch", clientName: "Northside Bikes", ageHours: 5,
    proposal: {
      title: "Investor pitch deck", employee: "Finance and funding consultant", days: 7,
      brief: [
        { label: "How much the client wants to raise", value: "£150,000 for a second shop" },
        { label: "Last 12 months of sales", value: "From Square: £412,000, up 18%" },
        { label: "Who the investors are" },
      ],
      design: "A 12-slide deck with the numbers checked against the books, plus a one-page summary.",
      plan: [{ title: "Story and slide outline", energy: 120 }, { title: "Financial slides from the books", energy: 300 }, { title: "Design and one-page summary", energy: 250 }],
    },
  },
];
