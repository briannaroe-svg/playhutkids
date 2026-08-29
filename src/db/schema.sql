-- Little Playhut App — Database Schema
-- Target: Neon Postgres (or Render Postgres)
-- Mirrors patterns from HangarHub Mx (KP Aviation) where applicable:
--   - line-item billing tables
--   - credit/adjustment ledger pattern
--   - agreement + signature split (agreements.js pattern)

-- ============================================================
-- FAMILIES & CHILDREN
-- ============================================================

CREATE TABLE families (
    id SERIAL PRIMARY KEY,
    primary_parent_name VARCHAR(255) NOT NULL,
    primary_parent_email VARCHAR(255) NOT NULL,
    primary_parent_phone VARCHAR(50),
    secondary_parent_name VARCHAR(255),
    secondary_parent_email VARCHAR(255),
    secondary_parent_phone VARCHAR(50),
    mailing_address TEXT,
    stripe_customer_id VARCHAR(255),        -- Stripe Customer object, once created
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE children (
    id SERIAL PRIMARY KEY,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    program VARCHAR(50) NOT NULL,           -- 'daycare' | 'preschool'
    enrollment_status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, waitlist, withdrawn
    enrollment_date DATE,
    withdrawal_date DATE,
    allergies TEXT,
    medical_notes TEXT,
    emergency_contact_name VARCHAR(255),
    emergency_contact_phone VARCHAR(50),
    base_tuition_rate NUMERIC(10,2),        -- monthly/weekly base rate before adjustments
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_children_family ON children(family_id);
CREATE INDEX idx_children_status ON children(enrollment_status);

-- ============================================================
-- FEE ADJUSTMENTS (credit/debit ledger — same pattern as KP's customer_credits)
-- ============================================================

CREATE TABLE fee_adjustments (
    id SERIAL PRIMARY KEY,
    child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    adjustment_type VARCHAR(50) NOT NULL,   -- 'discount', 'sibling_rate', 'credit', 'late_fee', 'scholarship'
    amount NUMERIC(10,2) NOT NULL,          -- negative = discount/credit, positive = added fee
    reason TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,                          -- null = ongoing
    created_by VARCHAR(255),                -- staff member who applied it
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fee_adjustments_child ON fee_adjustments(child_id);

-- ============================================================
-- INVOICES (mirrors KP's invoices.js / invoice_line_items pattern)
-- ============================================================

CREATE TABLE invoices (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    family_id INTEGER NOT NULL REFERENCES families(id),
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'draft', -- draft, sent, paid, overdue, void
    subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
    adjustments_total NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(10,2) NOT NULL DEFAULT 0,
    grand_total NUMERIC(10,2) NOT NULL DEFAULT 0,   -- matches KP naming convention
    payment_method VARCHAR(50),              -- cash, check, card, ach
    stripe_payment_intent_id VARCHAR(255),
    stripe_payment_link_url TEXT,
    paid_at TIMESTAMPTZ,
    pdf_url TEXT,                            -- Cloudinary URL once generated
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_family ON invoices(family_id);
CREATE INDEX idx_invoices_status ON invoices(status);

CREATE TABLE invoice_line_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    child_id INTEGER REFERENCES children(id),
    line_number INTEGER NOT NULL,
    description VARCHAR(255) NOT NULL,       -- e.g. "Tuition - August", "Late Pickup Fee"
    item_type VARCHAR(50) NOT NULL,          -- 'tuition', 'fee', 'adjustment', 'custom'
    quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL,
    line_total NUMERIC(10,2) NOT NULL
);

CREATE INDEX idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);

-- ============================================================
-- STAFF & TIMESHEETS
-- ============================================================

CREATE TABLE staff (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(50),
    role VARCHAR(100),                       -- lead teacher, aide, director, etc.
    hourly_rate NUMERIC(10,2),               -- for future payroll calc
    pin_code VARCHAR(10),                    -- for simple clock-in PIN auth
    is_active BOOLEAN NOT NULL DEFAULT true,
    hired_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE timesheet_entries (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    clock_in TIMESTAMPTZ NOT NULL,
    clock_out TIMESTAMPTZ,
    total_hours NUMERIC(6,2),                -- computed on clock-out
    notes TEXT,
    edited_by VARCHAR(255),                  -- if a manager manually corrected the entry
    edited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_timesheet_staff ON timesheet_entries(staff_id);
CREATE INDEX idx_timesheet_clockin ON timesheet_entries(clock_in);

-- ============================================================
-- AGREEMENTS (handbook e-signing — mirrors KP's agreements.js closely)
-- ============================================================

CREATE TABLE agreement_templates (
    id SERIAL PRIMARY KEY,
    agreement_type VARCHAR(50) NOT NULL,     -- 'daycare_handbook', 'preschool_handbook'
    version VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content_url TEXT,                        -- Cloudinary URL to the source PDF/doc
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agreements (
    id SERIAL PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES agreement_templates(id),
    family_id INTEGER NOT NULL REFERENCES families(id),
    child_id INTEGER REFERENCES children(id),  -- null if it applies to whole family
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, sent, signed, expired
    sign_method VARCHAR(50),                 -- 'in_person_canvas', 'remote_link'
    remote_link_token VARCHAR(255) UNIQUE,   -- for the 72-hour email link pattern
    remote_link_expires_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    signed_at TIMESTAMPTZ,
    signed_pdf_url TEXT,                     -- Cloudinary URL to final signed PDF
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agreements_family ON agreements(family_id);
CREATE INDEX idx_agreements_token ON agreements(remote_link_token);

CREATE TABLE agreement_signatures (
    id SERIAL PRIMARY KEY,
    agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
    signer_name VARCHAR(255) NOT NULL,
    signature_data TEXT NOT NULL,            -- base64 canvas signature image
    signed_ip VARCHAR(50),
    signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- NOTES
-- ============================================================
-- item_type / adjustment_type / status fields use VARCHAR + app-level validation
-- rather than Postgres ENUMs, matching the flexibility of KP's schema style.
-- Add CHECK constraints later once the exact value sets are finalized.
