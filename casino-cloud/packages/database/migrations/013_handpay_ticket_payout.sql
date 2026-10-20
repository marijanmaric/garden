-- 013 (F3): commercial modules decoupled from unnecessary cash dependencies.
--
-- The only schema change: a handpay can be paid as a TITO voucher (HANDPAY_PAY: HANDPAY_PAYABLE ->
-- TICKET_LIABILITY), so a casino without a cash desk (TITO + HANDPAY) can pay jackpots electronically.
-- The voucher is an ordinary ticket: redeemed at a machine (or a cash desk where one exists), expires and
-- is cancelled under the existing TITO rules. No historical row changes; no balance changes.

ALTER TABLE handpays DROP CONSTRAINT handpays_pay_method_check;
ALTER TABLE handpays ADD CONSTRAINT handpays_pay_method_check CHECK (pay_method IN ('CASH', 'WALLET', 'TICKET'));

-- the voucher of a TICKET payout: exactly one per handpay, one handpay per voucher
ALTER TABLE handpays ADD COLUMN payout_ticket_id uuid UNIQUE REFERENCES tickets(id);
ALTER TABLE handpays ADD CONSTRAINT handpays_ticket_payout CHECK (
  (payout_ticket_id IS NULL OR pay_method = 'TICKET') AND (pay_method IS DISTINCT FROM 'TICKET' OR payout_ticket_id IS NOT NULL));

-- a ticket's liability is created exactly once: machine print, cashier sale, or handpay voucher
CREATE UNIQUE INDEX money_transactions_one_ticket_origin ON money_transactions (ticket_id)
  WHERE ticket_id IS NOT NULL AND type IN ('TITO_ISSUE_MACHINE', 'TITO_ISSUE_CASHIER', 'HANDPAY_PAY');
