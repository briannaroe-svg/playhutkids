# Little Playhut Backend

Backend for The Little Playhut Preschool and Daycare (playhutkids.com).
Architecture mirrors the KP Aviation / HangarHub Mx stack: Node/Express on Render,
Postgres on Neon, Cloudinary for file/image storage, Stripe for payments.

## Stack

- **App hosting:** Render (Web Service, Node/Express)
- **Database:** Neon Postgres (or Render Postgres — either works, Neon matches the KP pattern)
- **File/image storage:** Cloudinary (logo, handbook PDFs, signed agreement PDFs)
- **Payments:** Stripe (separate Stripe account from KP Aviation — different business)
- **Frontend:** static site, hosted separately (Namecheap or wherever playhutkids.com's
  DNS ends up pointing), talks to this backend over the CORS-whitelisted API

## First-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (Neon connection string,
   Stripe test keys, Cloudinary credentials)
3. Run the schema against your Neon/Render Postgres instance:
   ```
   psql $DATABASE_URL -f src/db/schema.sql
   ```
4. `npm run dev` to run locally with nodemon, or `npm start` for production mode

## Deploying to Render

- Connect this repo to a new Render Web Service
- Build command: `npm install`
- Start command: `npm start`
- Set all `.env.example` variables as environment variables in the Render dashboard
- Decide auto-deploy vs manual-deploy on purpose (KP runs manual-only deploy —
  worth deciding the same way here rather than defaulting to auto)

## Feature map

| Feature | Route file | Status |
|---|---|---|
| Child registration / roster | `src/routes/children.js` | Scaffolded, working CRUD |
| Family records | `src/routes/families.js` | Scaffolded, working CRUD |
| Invoicing + Stripe payment links | `src/routes/invoices.js` | Scaffolded, working CRUD + Stripe Payment Links |
| Fee adjustments (discounts/credits) | `src/routes/feeAdjustments.js` | Scaffolded, working CRUD |
| Staff directory | `src/routes/staff.js` | Scaffolded, working CRUD |
| Timesheets / clock in-out | `src/routes/timesheets.js` | Scaffolded, working clock-in/out + manual correction |
| Handbook e-signing (daycare + preschool) | `src/routes/agreements.js` | Scaffolded, working remote link + in-person signing flow |

## Known TODOs

- Invoice PDF generation (PDFKit, same as KP's `generateQuotePDF.js`) not yet built
- Signed agreement PDF generation + Cloudinary upload not yet built (stubbed with TODO in `agreements.js`)
- Email sending (invoices, remote signing links) not yet wired — nodemailer is installed but unused
- Stripe webhook handler for auto-marking invoices paid not yet built — `mark-paid` is currently manual-only
- Payroll calculation from timesheet hours not yet built (schema supports it via `staff.hourly_rate`, no calc logic yet)
- Frontend (admin dashboard + parent-facing pages) not started

## Route ordering rules (carried over from KP — same lesson applies here)

Specific/static paths must be registered before parameterized `/:id` routes, or the
parameterized route will shadow them. Example in `invoices.js`: `/tax-report` is
declared before `/:id`. All `/:id` routes use a numeric regex guard (`/:id(\\d+)`)
so string paths like `/search` never get swallowed by an ID route.

## CORS

Whitelist lives in `src/server.js`. Update `allowedOrigins` once the actual Render
URL and final frontend domain are known — currently placeholder values for
`playhutkids.com` and an assumed Render URL.
