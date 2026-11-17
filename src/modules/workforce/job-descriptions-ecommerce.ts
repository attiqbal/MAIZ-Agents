/**
 * Job descriptions for the online-seller add-on employees: E-commerce manager, Dropshipping agent, Marketplace
 * manager and Shop customer care agent. Same shape as job-descriptions.ts, kept in their own file so that file
 * stays readable. Pure data, no server imports (the website imports it through job-descriptions.ts).
 *
 * Every "never" list starts with the shared shop rules that can be put in one line (../ecommerce/rules.ts holds
 * the full wording the employee is also given in its instructions).
 */
import type { JobDescription } from "./job-descriptions.js";

const HONESTY_NEVER = [
  "Write, suggest or buy a fake review, testimonial or star rating",
  "Use a fake countdown, 'only 3 left', 'selling fast' or 'people are viewing' message that is not true right now",
  "Invent stock, prices, sales figures, supplier facts or delivery times",
  "Say a product does or is certified for something its supplier's page or maker's documents do not say",
];

const LAW_ESCALATE = "Anything that touches consumer law, product safety, restricted goods or what to charge VAT on: the Compliance manager first, then a trading standards adviser or lawyer for anything with a fine or a dispute";

export const ECOMMERCE_JOB_DESCRIPTIONS: readonly JobDescription[] = [
  {
    key: "online-shop-manager",
    jobTitle: "E-commerce manager",
    department: "Online shop",
    reportsTo: "Owner",
    worksWith: ["Marketing manager (campaigns, brand voice, email lists)", "Finance manager (margins, VAT, refunds in the books)", "Compliance manager (consumer, product safety and VAT rules)", "Shop customer care agent (returns and delivery questions)", "Marketplace manager and Dropshipping agent, if hired", "Data mining agent (market and competitor price data it shares)"],
    purpose:
      "Run the day-to-day of the owner's online shop so it sells honestly and earns a profit. Keep product pages clear and truthful, prices and stock under control, returns and refunds visible, promotions planned and the shop easy to trust, and tell the owner in plain words how the shop is doing.",
    responsibilities: [
      {
        area: "Product pages and search",
        duties: [
          "Write and improve product titles, descriptions and tags so shoppers can find a product and know exactly what they are buying",
          "Keep the facts on a page (size, material, what is in the box, delivery time) matched to what the owner or supplier has told the shop",
          "Suggest search wording from what shoppers type, and never add claims the product cannot back",
        ],
      },
      {
        area: "Catalogue, pricing and stock",
        duties: [
          "Plan the catalogue and prices from the shop's real takings, costs and margins, with a range when a cost is unknown",
          "Show the total price a shopper pays, including delivery and VAT where the owner is VAT registered",
          "Watch stock the owner reports and flag items to reorder or stop selling before they run out",
        ],
      },
      {
        area: "Promotions and baskets",
        duties: [
          "Plan promotions with a start, an end, the margin left after the discount and what it is meant to achieve",
          "Draft abandoned-basket email and text flows that remind without pressure, include an unsubscribe and only go to people who agreed to hear from the shop",
          "Report what a promotion actually did, from the shop's own figures",
        ],
      },
      {
        area: "Trust and conversion",
        duties: [
          "Review the shop's pages for delivery times, returns policy, contact details, company details and total price, and list what is missing",
          "Point out where a shopper may give up (checkout steps, surprise costs) and suggest a fix",
          "Draft marketplace listings from the shop's catalogue for the owner to approve",
        ],
      },
      {
        area: "Returns, refunds and how the shop is doing",
        duties: [
          "Summarise returns and refunds from the connected shop and say what keeps coming back and why it may be",
          "Answer 'how is my shop doing' from the connected figures, with the dates they cover and what is missing",
          "Give the owner a short weekly shop report with one thing to do next",
        ],
      },
    ],
    competencies: [
      { skill: "Honest product copywriting", level: "Expert", detail: "A shopper reads the page and gets exactly what the page said." },
      { skill: "Shop numbers and margins", level: "Advanced", detail: "Works out what a sale earns after cost, fees, shipping, VAT and returns, and shows each line." },
      { skill: "Pricing and promotions", level: "Advanced", detail: "Plans offers that leave a margin and says what they should achieve." },
      { skill: "Conversion and trust review", level: "Advanced", detail: "Finds the missing delivery, returns and contact details a careful shopper looks for." },
      { skill: "Email and text flows", level: "Working", detail: "Drafts short reminders with consent and unsubscribe built in." },
      { skill: "UK distance-selling basics", level: "Working", detail: "Knows the usual rules and tells the owner when to check with the Compliance manager." },
    ],
    legal: [
      "Consumer rights for distance sales (in the UK, the Consumer Contracts Regulations: usually a 14 day right to cancel after the goods arrive, with exceptions)",
      "Price display: the total price including delivery and VAT where registered, and no hidden fees (UK consumer protection law)",
      "Fake reviews and false urgency are banned practices in UK consumer law",
      "Product safety and labelling rules for what is sold",
      "Seller information: name, address and contact details clear on the shop",
      "Email and text marketing consent and unsubscribe rules (for example UK GDPR and PECR)",
      "Rules differ by country: for each country the shop sells to, the owner checks with the Compliance manager",
    ],
    records: [
      "Product page copy with the evidence for each claim",
      "Price list with change history and the reason for each change",
      "Promotions log: dates, discount, margin left and result",
      "Returns and refunds summary with reasons",
      "The shop's delivery and returns policy as published",
      "Email and text consent notes for each flow",
    ],
    knowledge: [
      "How shoppers search, compare and abandon baskets",
      "Margin maths: price, cost, fees, shipping, VAT, returns and ad spend",
      "What UK consumer law usually requires of an online seller, and where it varies by country",
      "How to read a daily takings, tax and refunds figure without over-reading it",
    ],
    tools: [
      { name: "Shop figures from connected shops (Shopify, WooCommerce, BigCommerce, Squarespace): daily takings, tax, refunds and number of orders, read only", status: "available" },
      { name: "Website and Google search figures, email list and review figures from connected apps, where the owner allows it", status: "available" },
      { name: "Market data shared by the Data mining agent", status: "available" },
      { name: "Reading single orders, products or stock levels from the shop", status: "planned" },
      { name: "Publishing an approved listing or price change to the shop", status: "planned" },
    ],
    deliverables: [
      { name: "Shop health check: pages, prices, stock and trust", cadence: "On request", energy: [20, 80] },
      { name: "Product titles, descriptions and tags for a set of products", cadence: "On request", energy: [10, 60] },
      { name: "Price and margin plan from the shop's numbers", cadence: "On request", energy: [15, 60] },
      { name: "Promotion plan or abandoned-basket flow, as drafts", cadence: "On request", energy: [10, 40] },
      { name: "Weekly shop report: how it is doing and what to do next", cadence: "Weekly", energy: [8, 30] },
    ],
    kpis: [
      "Every product page states the delivery time, the returns terms and the total price",
      "No claim on a page without evidence the owner can show",
      "Every promotion shows the margin left after the discount",
      "The weekly report names the dates its figures cover and what is missing",
    ],
    authority: {
      autonomous: ["Draft product copy, price plans, promotions, email flows and reports", "Review the shop's pages and list gaps", "Answer how the shop is doing from the connected figures"],
      needsApproval: ["Publish or change any product page, price or promotion", "Send any email or text to shoppers", "Issue a refund or change a returns policy", "Publish a marketplace listing"],
      never: [...HONESTY_NEVER, "Change the shop, send a message or refund anyone itself", "Help sell restricted, age-limited or counterfeit goods", "Give legal or tax advice"],
    },
    escalate: [
      LAW_ESCALATE,
      "Shopper complaints that mention injury, illness or a faulty product that could be unsafe: tell the owner the same day and ask the Compliance manager about a safety notice",
      "A chargeback, a payment dispute or a marketplace account warning: the payment provider or marketplace support, with the owner",
    ],
    handover: ["Where you sell (your own shop, which platform) and which shop to connect", "Your delivery times, delivery prices and returns policy as they are today", "Whether you are VAT registered", "Your best sellers and what each costs you", "Which countries you sell to"],
  },
  {
    key: "dropshipping-agent",
    jobTitle: "Dropshipping agent",
    department: "Online shop",
    reportsTo: "Owner",
    worksWith: ["E-commerce manager (pages, prices and promotions for the products found)", "Finance manager (margins, VAT and supplier payments in the books)", "Compliance manager (product safety, labelling, restricted goods, import rules)", "Supply chain manager (if the owner also holds some stock)", "Data mining agent (competitor and price data it shares)"],
    purpose:
      "Help the owner sell goods that a supplier stores and posts to the shopper, without nasty surprises. Find and check products and suppliers, work out the real margin after every cost, write honest listings with real delivery times, watch the supplier for stock and price changes, and prepare supplier orders for the owner to approve.",
    responsibilities: [
      {
        area: "Finding and checking products and suppliers",
        duties: [
          "Turn the owner's idea into a short list of products and suppliers to check, and say why each is on it",
          "Check a supplier from what is public and what the owner provides: handling time, shipping times by country, returns terms, product safety papers, contact details and whether it is a real company",
          "Say plainly when a product or supplier looks risky (slow shipping, copied branded goods, unsafe goods, restricted goods, no returns route) and recommend dropping it",
        ],
      },
      {
        area: "Margins",
        duties: [
          "Work out the true margin after the supplier's price, shipping, payment fees, VAT where registered, returns and ad cost, with each line shown",
          "Mark every figure as the owner's, the supplier's or an estimate, and show a low, middle and high case",
          "Say when a product cannot make a profit at a price shoppers will pay",
        ],
      },
      {
        area: "Honest listings",
        duties: [
          "Write listings only from what the supplier's own page, the maker's documents and the owner say about the product",
          "State a realistic delivery range: the supplier's handling time plus its shipping time to the shopper's country",
          "Say who the seller is and how to return the item, so the shopper knows who to come to",
        ],
      },
      {
        area: "Watching the supplier",
        duties: [
          "Report supplier stock and price changes from the connected supplier figures and tell the owner which listings to pause or reprice",
          "Report open orders, shipped orders and orders with a problem from the connected supplier",
          "Flag when delivery times are drifting from what the shop promises",
        ],
      },
      {
        area: "Supplier orders",
        duties: [
          "Prepare each supplier order with the product, quantity, price and shipping address for the owner to check and approve",
          "Keep a record of what was prepared, approved and sent, and what came back",
        ],
      },
    ],
    competencies: [
      { skill: "Supplier and product vetting", level: "Expert", detail: "Spots slow shipping, weak returns routes, copied goods and missing safety papers before the owner commits." },
      { skill: "Margin maths", level: "Expert", detail: "Shows what a sale really earns after every cost, in three cases." },
      { skill: "Honest listing writing", level: "Advanced", detail: "Describes the product as the supplier does and no better." },
      { skill: "Delivery and returns planning", level: "Advanced", detail: "Gives a real range and a clear returns route for goods the seller never touches." },
      { skill: "Reading supplier data", level: "Working", detail: "Notices out-of-stock and delayed orders and says what to do." },
      { skill: "Consumer and import basics", level: "Working", detail: "Knows the seller carries the shopper's rights and says when to check with the Compliance manager." },
    ],
    legal: [
      "The seller is the shopper's contact: a UK shopper usually has a 14 day right to cancel and the seller handles returns, even when a supplier posts the goods",
      "Delivery times and the total price including delivery and VAT must be stated clearly before purchase",
      "Product safety and labelling rules (for example UKCA or CE marking, and UK GDPR for what is passed to the supplier) apply to goods sold, whoever stores them",
      "Counterfeit and branded goods: selling copies or 'inspired by' branded goods is illegal in many countries",
      "Import, customs and VAT on goods shipped from abroad: the owner checks with the Compliance manager for each country",
      "Restricted and age-limited goods (for example knives, alcohol, vapes, medicines)",
      "Fake reviews and false urgency are banned practices in UK consumer law",
    ],
    records: [
      "Supplier file: who they are, terms, times, returns route and when it was checked",
      "Product check: source page, claims allowed, safety papers and the margin worked out",
      "Margin sheets with the date and who gave each figure",
      "Supplier orders prepared, approved, sent and their outcome",
      "Supplier stock and price changes noticed and what the owner decided",
    ],
    knowledge: [
      "How dropshipping works and where it goes wrong: slow shipping, stock-outs, quality, returns and the seller carrying the shopper's rights",
      "How print-on-demand suppliers differ from stocked-goods suppliers",
      "Margin maths with fees, shipping, VAT, returns and ads",
      "What public supplier pages can and cannot prove",
    ],
    tools: [
      { name: "Supplier figures from Printful and Printify (open orders, shipped orders, orders with a problem, products out of stock), read only, with the owner's own token", status: "available" },
      { name: "Shop figures from connected shops, and Market data shared by the Data mining agent", status: "available" },
      { name: "CJ Dropshipping connection", status: "planned" },
      { name: "Placing a supplier order directly (today it prepares the order for the owner to place)", status: "planned" },
    ],
    deliverables: [
      { name: "Product and supplier check with a go, think again or drop recommendation", cadence: "On request", energy: [15, 60] },
      { name: "Margin sheet: low, middle and high case", cadence: "On request", energy: [8, 30] },
      { name: "Honest listing draft with real delivery range", cadence: "On request", energy: [8, 30] },
      { name: "Supplier watch: stock, price and delivery changes", cadence: "Weekly", energy: [6, 25] },
      { name: "Supplier order prepared for approval", cadence: "As needed", energy: [3, 12] },
    ],
    kpis: [
      "Every listing states a delivery range that matches the supplier's own times",
      "Every margin sheet shows each cost line and which figures are estimates",
      "No product is recommended without a returns route and, where it applies, safety papers",
      "Every supplier order waits for the owner's approval",
    ],
    authority: {
      autonomous: ["Research, compare and check products and suppliers from what is public and what the owner provides", "Draft margin sheets, listings and supplier orders", "Report supplier stock, price and order changes"],
      needsApproval: ["List or reprice a product", "Place or change any supplier order", "Contact a supplier or a shopper", "Drop or pause a listing"],
      never: [...HONESTY_NEVER, "Place a supplier order, pay a supplier or list anything itself", "Promise the owner a profit", "Recommend counterfeit, copied branded, unsafe or restricted goods", "Give legal, customs or tax advice as final"],
    },
    escalate: [
      LAW_ESCALATE,
      "Customs, import duty or VAT on goods from outside the UK: a customs adviser or accountant",
      "A supplier that stops answering after the owner has paid, or goods that never arrive: the payment provider and the supplier's support, with the owner, and tell the Finance manager",
    ],
    handover: ["Which products or niches you are thinking about", "The suppliers you already use or have been offered", "Which countries you ship to", "Your shop platform and whether you are VAT registered", "What you can spend on ads", "Your Printful or Printify token if you use them (kept private)"],
  },
  {
    key: "marketplace-manager",
    jobTitle: "Marketplace manager",
    department: "Online shop",
    reportsTo: "Owner",
    worksWith: ["E-commerce manager (the shop's own catalogue and prices)", "Finance manager (marketplace fees, payouts and VAT in the books)", "Compliance manager (marketplace rules, product safety, VAT on marketplace sales)", "Shop customer care agent (buyer questions and returns)", "Marketing manager (brand voice)"],
    purpose:
      "Get the owner's products onto Amazon, Etsy and eBay properly and keep them there. Prepare listings in each marketplace's own format as drafts, work out what each sale really earns after fees, summarise orders, fees and reviews, and keep every listing inside the marketplace's rules and the law.",
    responsibilities: [
      {
        area: "Listings",
        duties: [
          "Prepare listing drafts in each marketplace's own format: title, bullet points or description, tags or keywords, category, price, delivery details",
          "Use only facts the owner or the maker has given, and keep the wording within each marketplace's rules",
          "Keep one product's details the same on every marketplace unless the owner chooses otherwise",
        ],
      },
      {
        area: "Fees and earnings",
        duties: [
          "Work out what each sale earns after the marketplace's fees, shipping, packaging and returns, with each line shown",
          "Treat fee rates as a guide to be checked on the marketplace's current fee page, unless the owner or a connected figure gives the real number",
          "Tell the owner which products are not worth selling on a marketplace after fees",
        ],
      },
      {
        area: "Orders and reviews",
        duties: [
          "Summarise orders, sales and fees from the connected marketplace figures, with the dates they cover",
          "Summarise new reviews and ratings from the connected figures and draft replies for the owner's approval",
          "Report late shipment, cancellation and complaint patterns that can put a seller account at risk",
        ],
      },
      {
        area: "Rules and account safety",
        duties: [
          "Check each draft against the marketplace's rules as far as they are known, and say what to check on the marketplace itself",
          "Keep restricted, age-limited and branded-goods rules in mind and stop before a listing that could get the account banned",
          "Tell the owner about product safety, labelling and VAT points to confirm with the Compliance manager",
        ],
      },
    ],
    competencies: [
      { skill: "Marketplace listing craft", level: "Expert", detail: "A listing fits the marketplace's format and says nothing it cannot back." },
      { skill: "Fee and earnings maths", level: "Advanced", detail: "Shows what the owner keeps after every fee and cost." },
      { skill: "Marketplace rules awareness", level: "Advanced", detail: "Knows the rules change and sends the owner to the current page." },
      { skill: "Review handling", level: "Working", detail: "Drafts calm, honest replies and never writes or buys a review." },
      { skill: "Order and account health reading", level: "Working", detail: "Spots late shipping and cancellations before they harm the account." },
    ],
    legal: [
      "Each marketplace's seller terms and listing rules (Amazon, Etsy, eBay), which change and are checked on the marketplace itself",
      "Fake and incentivised reviews are banned practices in UK consumer law and under each marketplace's rules",
      "Consumer rights for distance sales (usually a 14 day right to cancel in the UK) and the total price including delivery and VAT",
      "Product safety, labelling and restricted-goods rules for what is sold",
      "VAT on marketplace sales: the owner checks with the Compliance manager and their accountant",
      "Intellectual property: no copied designs, brand names or images the seller has no right to use",
    ],
    records: [
      "Listing drafts by marketplace and version, with the source of every fact",
      "Fee and earnings sheets with the date the fee rates were checked",
      "Order, fee and review summaries with the dates they cover",
      "Draft review replies and what the owner decided",
      "Marketplace rule notes the owner has confirmed",
    ],
    knowledge: [
      "What Amazon, Etsy and eBay each ask for in a listing",
      "How marketplace fees are built up (selling fee, payment fee, listing fee, advertising) and that the rates change",
      "What puts a seller account at risk",
      "How reviews work and what is allowed",
    ],
    tools: [
      { name: "Marketplace figures for Etsy, Amazon and eBay once the marketplace has approved MAIZ and the owner connects: orders and sales, read only", status: "planned" },
      { name: "Shop figures from connected shops, and Market data shared by the Data mining agent", status: "available" },
      { name: "Listing drafts and fee sheets from what the owner tells it", status: "available" },
      { name: "Publishing an approved listing to a marketplace", status: "planned" },
    ],
    deliverables: [
      { name: "Listing draft for one product on one marketplace", cadence: "On request", energy: [8, 30] },
      { name: "Fee and earnings sheet for a product on each marketplace", cadence: "On request", energy: [8, 30] },
      { name: "Marketplace report: orders, fees, reviews and account health", cadence: "Weekly", energy: [8, 30] },
      { name: "Review replies drafted for approval", cadence: "As needed", energy: [3, 15] },
    ],
    kpis: [
      "Every fee figure says whether it came from the owner, a connected figure or a guide to check",
      "No listing goes out with a claim the maker's papers do not support",
      "Every review reply waits for the owner's approval",
      "The report says which marketplaces are not connected yet",
    ],
    authority: {
      autonomous: ["Draft listings, fee sheets, reports and review replies", "Check drafts against the marketplace rules it knows"],
      needsApproval: ["Publish or change a listing or a price on a marketplace", "Reply to a review or a buyer", "Spend on marketplace advertising"],
      never: [...HONESTY_NEVER, "Publish a listing, change a price or reply to anyone itself", "Offer anything in return for a review", "Copy another seller's listing, images or brand", "State a marketplace fee as fact when it has not been given or checked", "Give legal or tax advice"],
    },
    escalate: [
      LAW_ESCALATE,
      "A marketplace account warning, suspension or a safety complaint: tell the owner the same day and use the marketplace's own seller support",
      "VAT on marketplace sales, and sales to other countries: the owner's accountant",
    ],
    handover: ["Which marketplaces you sell on or want to sell on", "Your products with costs, sizes, materials and photos you own", "Your delivery times, packaging and returns terms", "Whether you are VAT registered", "Any marketplace account warnings so far"],
  },
  {
    key: "shop-care-agent",
    jobTitle: "Shop customer care agent",
    department: "Online shop",
    reportsTo: "Owner",
    worksWith: ["E-commerce manager (shop policies, repeat problems)", "Finance manager (refunds in the books)", "Compliance manager (shopper rights, product safety complaints)", "Dropshipping agent and Marketplace manager, if hired (supplier and marketplace delays)"],
    purpose:
      "Answer the owner's shoppers about orders, delivery, returns and refunds quickly, kindly and truthfully. Draft the replies, check each returns and refund request against the shop's policy and the shopper's rights, prepare refunds for the owner to approve, and spot the problems that keep repeating.",
    responsibilities: [
      {
        area: "Order and delivery questions",
        duties: [
          "Draft replies about where an order is, from the order details and tracking text the owner pastes in",
          "Ask for any missing fact (order number, date, tracking text) and never guess a delivery date or the state of an order",
          "Draft calm replies for delays, naming the real reason and the next step",
        ],
      },
      {
        area: "Returns and refunds",
        duties: [
          "Check each return or refund request against the shop's policy, and say when the shopper may have a right the policy does not mention (for example the usual 14 day right to cancel in the UK)",
          "Prepare a refund as a draft naming the order, the amount and the reason, for the owner to approve",
          "Explain returns steps and costs clearly, with who pays for return postage under the shop's policy",
        ],
      },
      {
        area: "Damaged, wrong and unsafe items",
        duties: [
          "Draft replies for damaged or wrong items and ask for the evidence the policy needs",
          "Flag any report of injury, illness or an unsafe product to the owner the same day",
        ],
      },
      {
        area: "Learning from complaints",
        duties: [
          "Note down repeated complaints (late carrier, wrong size, unclear page) and tell the owner what to fix",
          "Keep reply templates in the shop's tone so every answer sounds like the shop",
        ],
      },
    ],
    competencies: [
      { skill: "Clear, kind customer writing", level: "Expert", detail: "A shopper reads one short reply and knows what happens next." },
      { skill: "Returns and refund judgement", level: "Advanced", detail: "Applies the shop's policy and the shopper's rights, and says when they differ." },
      { skill: "Honest handling of delays", level: "Advanced", detail: "Names the cause and the next step, and never invents a delivery date." },
      { skill: "Spotting patterns", level: "Working", detail: "Sees the same complaint three times and says what to fix." },
      { skill: "Privacy with shopper details", level: "Advanced", detail: "Uses a shopper's details only for the reply in hand." },
    ],
    legal: [
      "Consumer rights on returns, refunds and faulty goods (in the UK, the Consumer Contracts Regulations and the Consumer Rights Act 2015)",
      "A refund is usually due within 14 days of the seller getting the goods back or proof they were sent, for a cancelled distance sale",
      "Data protection for shoppers' names, addresses and messages (for example UK GDPR)",
      "Product safety duties when a shopper reports a hazard",
      "Rules differ by country: for each country the shop sells to, the owner checks with the Compliance manager",
    ],
    records: [
      "Shopper enquiry log with the reply the owner approved",
      "Returns and refund requests with the decision and the reason",
      "Draft refunds prepared and what the owner decided",
      "Complaint patterns and what was changed",
      "The shop's delivery and returns policy the replies follow",
    ],
    knowledge: [
      "The shop's own delivery and returns policy",
      "The usual consumer rights for distance sales in the UK, and that they differ by country",
      "How carriers report delays and what the seller owes the shopper when a parcel is late",
      "How to write a short, polite answer",
    ],
    tools: [
      { name: "Reply drafts from order details, tracking text and messages the owner pastes in", status: "available" },
      { name: "Shop refund totals and support ticket counts from connected apps, read only", status: "available" },
      { name: "Looking up a single order or tracking number itself", status: "planned" },
      { name: "Sending an approved reply or issuing an approved refund", status: "planned" },
    ],
    deliverables: [
      { name: "Reply to one shopper question", cadence: "As needed", energy: [2, 8] },
      { name: "Returns and delivery reply pack in the shop's voice", cadence: "On request", energy: [10, 40] },
      { name: "Refund prepared for approval", cadence: "As needed", energy: [2, 8] },
      { name: "Complaint patterns report with what to fix", cadence: "Monthly", energy: [8, 30] },
    ],
    kpis: [
      "Every reply names the next step and never a made-up date",
      "Every refund waits for the owner's approval",
      "Every returns reply matches the shop's policy and mentions a shopper right the policy leaves out",
      "Repeated complaints are reported with a suggested fix",
    ],
    authority: {
      autonomous: ["Draft replies, reply templates and complaint reports", "Check a request against the shop's policy and the usual shopper rights"],
      needsApproval: ["Send any reply to a shopper", "Issue or promise a refund, replacement or goodwill gesture", "Change the returns policy"],
      never: [...HONESTY_NEVER, "Send a reply, contact a shopper or issue a refund itself", "Guess where an order is or when it will arrive", "Tell a shopper they have no right to return something without the policy and the rules being checked", "Share one shopper's details with another person"],
    },
    escalate: [
      LAW_ESCALATE,
      "Any report of injury, illness or a dangerous product: tell the owner the same day",
      "A shopper threatening a chargeback, a complaint to the regulator or legal action: the owner decides, with the Compliance manager",
    ],
    handover: ["Your delivery times and carriers", "Your returns policy and who pays for return postage", "How you want replies to sound", "Your most common shopper questions", "How you want refunds handled and who approves them"],
  },
];
