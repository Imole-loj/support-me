#![no_std]

//! Shared data types for the SupportMe contracts. Kept in their own crate so
//! that `donation` and `creator-registry` agree on a single, canonical
//! definition and can exchange values across contract calls.
//!
//! # Instance TTL
//!
//! Both contracts keep their critical configuration (admin set, threshold,
//! timelock, registry / donation contract address, executor, pause flag and
//! token allowlist) in instance storage. Instance storage shares a single TTL
//! with the contract instance, and extending it also extends the contract's
//! Wasm code entry. If that TTL lapses during a quiet period the contract is
//! archived and every call fails until someone submits a restore operation.
//!
//! To prevent that, every state-changing entry point calls
//! [`extend_instance_ttl`], and each contract exposes a permissionless
//! `bump()` that an off-chain scheduler (e.g. the backend executor) can call
//! during long idle periods:
//!
//! - [`INSTANCE_BUMP_AMOUNT`]: the TTL (in ledgers) the instance is extended
//!   to, ~30 days at 5s/ledger.
//! - [`INSTANCE_LIFETIME_THRESHOLD`]: the extension is only written once the
//!   remaining TTL falls below this (~29 days), so normal usage does not pay
//!   for a rent bump on every call.

use soroban_sdk::{contracttype, Address, Env, IntoVal, String, Val, Vec};

/// Approximate number of ledgers per day (5 second close time).
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// TTL, in ledgers, that the contract instance is extended to (~30 days).
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
/// Remaining TTL, in ledgers, below which the instance is re-extended.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

/// TTL, in ledgers, that long-lived persistent entries (creator profiles,
/// usernames, goals, subscriptions) are extended to (~90 days).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 90 * DAY_IN_LEDGERS;
/// Remaining TTL, in ledgers, below which a persistent entry is re-extended
/// (~60 days). Using a threshold keeps routine calls from paying a rent bump
/// every time while still leaving a wide margin before expiry.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - 30 * DAY_IN_LEDGERS;
/// Upper bound, in ledgers, for any single extension (~150 days). The network
/// caps entry TTLs (about 180 days), so requests are clamped below that.
pub const PERSISTENT_MAX_BUMP_AMOUNT: u32 = 150 * DAY_IN_LEDGERS;
/// Approximate seconds per ledger, used to convert intervals to ledgers.
pub const SECONDS_PER_LEDGER: u64 = 5;

/// Maximum lifetime of an admin proposal, in seconds.
///
/// `propose_admin_action` stamps `expires_at` with
/// `created_at + ADMIN_PROPOSAL_TTL_SECONDS`, and `execute_admin_action`
/// rejects execution once the ledger timestamp passes it, so a stale or
/// contested proposal can never be executed months after it was created.
pub const ADMIN_PROPOSAL_TTL_SECONDS: u64 = 7 * 86_400;

/// Extends the TTL of one persistent entry to [`PERSISTENT_BUMP_AMOUNT`] when it
/// has fallen below [`PERSISTENT_LIFETIME_THRESHOLD`]. The key must exist:
/// the host rejects extending an absent entry.
pub fn extend_persistent_ttl<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// TTL, in ledgers, a subscription entry should be extended to: comfortably
/// longer than its own charge interval (two intervals plus a month of slack),
/// but never less than [`PERSISTENT_BUMP_AMOUNT`] and never more than
/// [`PERSISTENT_MAX_BUMP_AMOUNT`]. Intervals longer than the cap (e.g. annual)
/// rely on the permissionless `bump_subscription` keep-alive between charges.
pub fn subscription_bump_amount(interval_secs: u64) -> u32 {
    let interval_ledgers = interval_secs.div_ceil(SECONDS_PER_LEDGER);
    let wanted = interval_ledgers
        .saturating_mul(2)
        .saturating_add(30 * DAY_IN_LEDGERS as u64);
    let clamped = wanted.clamp(
        PERSISTENT_BUMP_AMOUNT as u64,
        PERSISTENT_MAX_BUMP_AMOUNT as u64,
    );
    clamped as u32
}

/// Extends a subscription entry to [`subscription_bump_amount`] for its
/// interval, once the remaining TTL falls 30 days below that target.
pub fn extend_subscription_ttl<K: IntoVal<Env, Val>>(env: &Env, key: &K, interval_secs: u64) {
    let extend_to = subscription_bump_amount(interval_secs);
    env.storage().persistent().extend_ttl(
        key,
        extend_to.saturating_sub(30 * DAY_IN_LEDGERS),
        extend_to,
    );
}

/// Extends the TTL of the current contract's instance storage (and Wasm code)
/// to [`INSTANCE_BUMP_AMOUNT`] when it has fallen below
/// [`INSTANCE_LIFETIME_THRESHOLD`].
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DonationRecord {
    pub donor: Address,
    pub creator: Address,
    /// Gross amount the donor sent. The creator receives `amount -
    /// fee_amount`; the platform fee address receives `fee_amount`.
    pub amount: i128,
    /// Portion of `amount` routed to the platform fee address. Zero when no
    /// platform fee is configured.
    pub fee_amount: i128,
    pub memo: String,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct CreatorProfile {
    pub address: Address,
    pub username: String,
    pub total_donations: i128,
    pub donation_count: u32,
    pub created_at: u64,
}

/// A recurring donation. The supporter grants the donation contract a SAC
/// allowance (via the token contract's own `approve`) covering `amount` per
/// `interval_secs`; the donation contract then draws on that allowance via
/// `transfer_from` once per interval, on or after `next_charge_at`.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Subscription {
    pub supporter: Address,
    pub creator: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub next_charge_at: u64,
    pub active: bool,
}

/// Validates the initial admin set passed to a contract constructor: the list
/// must be non-empty and free of duplicates, and `threshold` must be between 1
/// and the number of admins.
pub fn validate_admin_set(admins: &Vec<Address>, threshold: u32) {
    assert!(!admins.is_empty(), "admin list cannot be empty");
    assert!(
        threshold > 0 && threshold <= admins.len(),
        "invalid signature threshold"
    );
    for i in 0..admins.len() {
        let admin = admins.get(i).unwrap();
        for j in (i + 1)..admins.len() {
            assert!(
                admins.get(j).unwrap() != admin,
                "duplicate admin in admin list"
            );
        }
    }
}

/// Administrative actions that require multi-signature approval and timelock.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum AdminAction {
    SetExecutor(Address),
    SetDonationContract(Address),
    AddAdmin(Address),
    RemoveAdmin(Address),
    SetThreshold(u32),
    Pause,
    Unpause,
    /// Adds a token to the donation contract's allowlist (#284). Routed
    /// through the proposal pipeline so a single key on a multisig
    /// deployment cannot unilaterally allowlist an arbitrary token.
    AddAllowedToken(Address),
    /// Removes a token from the donation contract's allowlist (#284).
    RemoveAllowedToken(Address),
    /// Sets the minimum donation guardrail, in the token's smallest unit
    /// (#284). Zero disables the floor.
    SetMinDonation(i128),
    /// Sets the maximum donation guardrail, in the token's smallest unit
    /// (#284). Zero disables the ceiling.
    SetMaxDonation(i128),
}

/// Proposal for sensitive multi-signature administrative changes.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AdminProposal {
    pub id: u64,
    pub action: AdminAction,
    pub proposer: Address,
    /// Cached count of approvals as of the most recent `approve_admin_action`.
    /// Advisory only: `execute_admin_action` recounts approvals from the
    /// *current* admin set instead of trusting this number, because an
    /// approving admin may have been removed since (or may hold a
    /// compromised key that was rotated out).
    pub approvals_count: u32,
    pub created_at: u64,
    pub eta: u64,
    /// Unix timestamp after which the proposal can no longer be executed
    /// (`created_at + ADMIN_PROPOSAL_TTL_SECONDS`).
    pub expires_at: u64,
    pub executed: bool,
    /// Set by `cancel_admin_action`; a cancelled proposal can never execute.
    pub cancelled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_bump_amount_scales_with_interval_within_bounds() {
        // Short intervals get the floor.
        assert_eq!(subscription_bump_amount(1), PERSISTENT_BUMP_AMOUNT);
        assert_eq!(subscription_bump_amount(86_400), PERSISTENT_BUMP_AMOUNT);
        // Monthly: 2 intervals + 30 days = 90 days -> still the floor.
        assert_eq!(
            subscription_bump_amount(30 * 86_400),
            PERSISTENT_BUMP_AMOUNT
        );
        // 60 days: 2 * 60 + 30 = 150 days -> the cap.
        assert_eq!(
            subscription_bump_amount(60 * 86_400),
            PERSISTENT_MAX_BUMP_AMOUNT
        );
        // Between floor and cap it scales: 45 days -> 2 * 45 + 30 = 120 days.
        assert_eq!(subscription_bump_amount(45 * 86_400), 120 * DAY_IN_LEDGERS);
        // Huge intervals (and u64::MAX) are clamped, never overflow.
        assert_eq!(
            subscription_bump_amount(u64::MAX),
            PERSISTENT_MAX_BUMP_AMOUNT
        );
        const _: () = assert!(PERSISTENT_MAX_BUMP_AMOUNT < 180 * DAY_IN_LEDGERS);
    }
}
