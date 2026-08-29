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
| Handbook e-signing (daycare + preschool) | `src/routes/agreements.js` | Working remote link + in-person signing flow, with signed-PDF generation (PDFKit) and Cloudinary upload |
| Staff login / auth | `src/routes/auth.js`, `src/middleware/auth.js` | Working — email/password login, JWT, two-tier access (`staff` / `admin`) |

## Authentication and access control

Two access levels on `staff.access_level`: `staff` and `admin`.

- `staff` can clock in/out (no login needed — PIN-based, `POST /timesheets/clock-in` and
  `/clock-out`) and, once logged into the dashboard, view **only their own** timesheet entries.
- `admin` can do everything staff can, plus manage children, families, invoices, fee
  adjustments, agreements, and other staff records, and correct any timesheet entry.

Dashboard login is separate from the clock-in PIN — it's `POST /auth/login` with email + password,
returning a JWT. Pass it as `Authorization: Bearer <token>` on every protected request.

### Creating the first admin account

There's a chicken-and-egg problem: no one can log in to create a staff record until an
admin account exists. `POST /auth/bootstrap-admin` solves this — it's guarded by a
`BOOTSTRAP_SECRET` env var (set your own long random value in Render) instead of a login,
and it refuses to run again once any admin account exists, so it can't be reused as a backdoor.

```bash
curl -X POST https://little-playhut-backend.onrender.com/auth/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "<your BOOTSTRAP_SECRET value>",
    "first_name": "Brianna",
    "last_name": "Roe",
    "email": "you@example.com",
    "password": "choose-a-real-password"
  }'
```

After this succeeds once, log in normally via `POST /auth/login` and use the dashboard (once
built) or `POST /staff` (admin-only) to add the rest of the team.

## Migrations

`src/db/schema.sql` is the original full schema. Anything added after the initial schema
lives in `src/db/migrations/`, applied in order. Run each new migration file the same way
you ran the original schema — paste into Neon's SQL Editor, or `psql $DATABASE_URL -f <file>`.

Current migrations:
- `001_add_staff_auth.sql` — adds `password_hash` and `access_level` to `staff`


- Invoice PDF generation (PDFKit, same as KP's `generateQuotePDF.js`) not yet built
- Email sending (invoices, remote signing links) not yet wired — nodemailer is installed but unused
- No admin UI yet for uploading the source handbook PDFs — use `POST /agreements/templates`
  with a `content_url` you've uploaded to Cloudinary yourself in the meantime (or omit
  `content_url` if the handbook text only needs to live in the signed-agreement PDF)
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
