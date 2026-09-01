ALTER TABLE payment_schedules
  ADD COLUMN IF NOT EXISTS vendor_confirmation_note TEXT;

ALTER TABLE payment_schedules
  ADD COLUMN IF NOT EXISTS vendor_confirmed_at TIMESTAMPTZ;

UPDATE payment_schedules
   SET vendor_confirmed_at = COALESCE(paid_at, updated_at),
       vendor_confirmation_note = COALESCE(
         vendor_confirmation_note,
         'Backfilled from an existing paid milestone.'
       )
 WHERE is_milestone_payment = TRUE
   AND paid_at IS NOT NULL
   AND vendor_confirmed_at IS NULL;