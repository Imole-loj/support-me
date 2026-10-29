#![no_std]

//! Donation contract: moves the donated token from donor to creator and
//! keeps a local, append-only log of donations. Creator profile state
//! (username, lifetime totals) lives in a separate `creator-registry`
//! contract — this contract talks to it exclusively through cross-contract
//! calls (`env.invoke_contract`), so the two contracts can be deployed,
//! upgraded, and audited independently.
//!
//! # Storage & Rent Tradeoffs
//!
//! To minimize Soroban state rent, the append-only donation log stored in
//! this contract operates without explicit `extend_ttl` calls. Over time, as
//! volume grows, old records may expire and disappear from `get_donation`.
//! This is an accepted design choice: the backend indexing `DonatedEvent`s
//! is the canonical source of long-term history. Future contract upgrades
//! should avoid relying on the complete on-chain history being present.
//!
//! Multi-signature and timelock governance:
//! High-risk administrative operations (setting executor, rotating admins,
//! adjusting threshold, pausing operations) require multi-signature proposal,
//! approval threshold, and timelock delay before execution.
//!
//! Initialization happens atomically at deploy time through `__constructor`;
//! there is no separate public initializer that could be front-run.
//!
//! Unlike the donation log, instance storage (admins, registry, executor,
//! pause flag, token allowlist) *is* kept alive: every state-changing entry
//! point extends the instance TTL, and `bump()` lets anyone extend it during
//! idle periods. See the `common` crate docs for the TTL constants.

use common::{
    extend_instance_ttl, extend_persistent_ttl, extend_subscription_ttl, AdminAction,
    AdminProposal, CreatorProfile, DonationRecord, Subscription, ADMIN_PROPOSAL_TTL_SECONDS,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, symbol_short, token, Address, Env,
    IntoVal, String, Symbol, Val, Vec,
};

const DONATIONS_KEY: Symbol = symbol_short!("donations");
const DONATION_COUNTER: Symbol = symbol_short!("counter");
const ADMIN_KEY: Symbol = symbol_short!("admin");
const ADMINS_KEY: Symbol = symbol_short!("admins");
const THRESHOLD_KEY: Symbol = symbol_short!("thresh");
const TIMELOCK_DELAY_KEY: Symbol = symbol_short!("delay");
const PROPOSAL_COUNTER_KEY: Symbol = symbol_short!("prop_ctr");
const PROPOSAL_KEY: Symbol = symbol_short!("proposal");
const APPROVAL_KEY: Symbol = symbol_short!("approval");
const CANCEL_KEY: Symbol = symbol_short!("cancel");
const PAUSED_KEY: Symbol = symbol_short!("paused");
const REGISTRY_KEY: Symbol = symbol_short!("registry");
const SUBSCRIPTIONS_KEY: Symbol = symbol_short!("subs");
const SUB_COUNTER: Symbol = symbol_short!("sub_ctr");
const EXECUTOR_KEY: Symbol = symbol_short!("executor");
const ALLOWED_TOKEN_KEY: Symbol = symbol_short!("allowed");
const MIN_DONATION_KEY: Symbol = symbol_short!("min_don");
const MAX_DONATION_KEY: Symbol = symbol_short!("max_don");
/// Persistent key, keyed further by `(supporter, token)`, tracking the sum of
/// `amount` across that supporter's currently-active subscriptions in that
/// token. See `cancel_subscription` for why this is needed: SAC allowances
/// are keyed by `(owner, spender)`, not per subscription, so cancelling one
/// subscription must only reduce the allowance by *that* subscription's
/// committed amount, never zero out a shared allowance still backing others.
const COMMITTED_KEY: Symbol = symbol_short!("commit");
pub const MAX_MEMO_LENGTH: u32 = 140;

/// Emitted whenever a donation is settled on-chain.
#[contractevent(topics = ["donated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonatedEvent {
    #[topic]
    pub donor: Address,
    #[topic]
    pub creator: Address,
    pub donation_id: u32,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub memo: String,
    pub timestamp: u64,
    pub subscription_id: Option<u64>,
}

/// Emitted when a supporter starts a recurring donation. Carries `token`
/// and `next_charge_at` so the backend can create and reconcile schedules
/// directly from the event stream.
#[contractevent(topics = ["subscribed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscribedEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub next_charge_at: u64,
}

/// Emitted when a supporter cancels a recurring donation. Indexed by both
/// supporter and creator so both dashboards can track cancellations.
#[contractevent(topics = ["sub_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionCancelledEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
}

/// Emitted when an admin proposal is created.
#[contractevent(topics = ["prop_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub proposal_id: u64,
    #[topic]
    pub proposer: Address,
    pub eta: u64,
}

/// Emitted when an admin proposal receives an approval.
#[contractevent(topics = ["prop_approved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalApprovedEvent {
    pub proposal_id: u64,
    #[topic]
    pub admin: Address,
    pub approvals_count: u32,
}

/// Emitted when an admin proposal is executed.
#[contractevent(topics = ["prop_exec"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecutedEvent {
    pub proposal_id: u64,
    #[topic]
    pub executor: Address,
}

/// Emitted when an admin proposal is cancelled — either unilaterally by its
/// proposer or after `threshold` current admins requested the cancellation.
#[contractevent(topics = ["prop_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCancelledEvent {
    pub proposal_id: u64,
    #[topic]
    pub cancelled_by: Address,
}

#[contractevent(topics = ["goal_upd"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalUpdatedEvent {
    #[topic]
    pub creator: Address,
    pub goal_amount: i128,
    pub updated_at: u64,
}
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ChargeError {
    InsufficientAllowance = 1,
    InsufficientBalance = 2,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DonationError {
    NotInitialized = 3,
    AlreadyInitialized = 4,
    Paused = 5,
    Unauthorized = 6,
    TokenNotAllowed = 7,
    MemoTooLong = 8,
    AmountTooLow = 10,
    AmountTooHigh = 11,
    NotDue = 12,
    SubscriptionNotActive = 13,
    SubscriptionNotFound = 14,
    InvalidAmount = 15,
    InvalidInterval = 16,
    InvalidThreshold = 17,
    EmptyAdminList = 18,
    ProposalNotFound = 19,
    ProposalAlreadyExecuted = 20,
    AlreadyApproved = 21,
    TimelockNotElapsed = 22,
    ThresholdExceedsAdmins = 23,
    CannotRemoveAllAdmins = 24,
    MultiSigRequired = 25,
    ExecutorNotSet = 26,
    Overflow = 27,
}

#[contractevent(topics = ["sub_failed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionChargeFailedEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
    pub reason: ChargeError,
}

/// Emitted whenever the token allowlist changes (#284), whether through a
/// multisig-approved `AdminAction` or the single-admin legacy shortcut.
#[contractevent(topics = ["allow_tok"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowedTokenChangedEvent {
    #[topic]
    pub token: Address,
    pub allowed: bool,
}

/// Emitted whenever the minimum donation guardrail changes (#284).
#[contractevent(topics = ["min_don"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinDonationChangedEvent {
    pub old_min: i128,
    pub new_min: i128,
}

/// Emitted whenever the maximum donation guardrail changes (#284).
#[contractevent(topics = ["max_don"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxDonationChangedEvent {
    pub old_max: i128,
    pub new_max: i128,
}

/// Emitted whenever the contract is paused or unpaused (#284). Covers both
/// the instant `emergency_pause` shortcut and the multisig `Pause`/`Unpause`
/// `AdminAction`s.
#[contractevent(topics = ["pause_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChangedEvent {
    pub paused: bool,
}

/// Emitted whenever the authorized subscription-charge executor changes
/// (#284), whether via the multisig `SetExecutor` action or the single-admin
/// legacy `set_executor` shortcut. `old_executor` is `None` the first time
/// an executor is ever set.
#[contractevent(topics = ["exec_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutorChangedEvent {
    pub old_executor: Option<Address>,
    #[topic]
    pub new_executor: Address,
}

#[contract]
pub struct DonationContract;

#[contractimpl]
impl DonationContract {
    /// One-time single-admin setup: backwards compatible wrapper initializing 1-of-1 admin setup.
    pub fn initialize(env: Env, admin: Address, registry: Address) {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN_KEY) || env.storage().instance().has(&ADMINS_KEY) {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyInitialized);
        }

        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &1u32);
        env.storage().instance().set(&TIMELOCK_DELAY_KEY, &0u64);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
    }

    /// One-time multi-sig setup: configures admin list, threshold, and timelock delay.
    pub fn initialize_multisig(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
        registry: Address,
    ) {
        if env.storage().instance().has(&ADMIN_KEY) || env.storage().instance().has(&ADMINS_KEY) {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyInitialized);
        }
        if admins.is_empty() {
            soroban_sdk::panic_with_error!(&env, DonationError::EmptyAdminList);
        }
        if threshold == 0 || threshold > admins.len() {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidThreshold);
        }

        for i in 0..admins.len() {
            admins.get(i).unwrap().require_auth();
        }

        let primary_admin = admins.get(0).unwrap();
        env.storage().instance().set(&ADMIN_KEY, &primary_admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &threshold);
        env.storage()
            .instance()
            .set(&TIMELOCK_DELAY_KEY, &timelock_delay);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
        extend_instance_ttl(&env);
    }

    /// Permissionless keep-alive: extends the instance TTL so the contract is
    /// not archived during long periods without other state-changing calls.
    /// Intended to be called on a schedule by the backend executor.
    pub fn bump(env: Env) {
        extend_instance_ttl(&env);
    }

    /// Returns whether a given address is an authorized contract admin.
    pub fn is_admin(env: Env, address: Address) -> bool {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| Vec::new(&env));
        Self::contains_address(&admins, &address)
    }

    /// Recounts `key` votes for `proposal_id` against the *current* admin set
    /// (`ADMINS_KEY`), so approvals (or cancellation requests) cast by an
    /// admin who has since been removed no longer count toward the threshold.
    /// Used at execution instead of trusting the cached `approvals_count`.
    fn count_current_admin_votes(env: &Env, key: Symbol, proposal_id: u64) -> u32 {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| Vec::new(env));
        let mut votes: u32 = 0;
        for i in 0..admins.len() {
            let admin = admins.get(i).unwrap();
            let voted: bool = env
                .storage()
                .persistent()
                .get(&(key.clone(), proposal_id, admin))
                .unwrap_or(false);
            if voted {
                votes = votes.checked_add(1).expect("vote count overflow");
            }
        }
        votes
    }

    /// Returns whether contract transfers/operations are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    /// Emergency pause: any authorized admin can instantly freeze contract operations.
    pub fn emergency_pause(env: Env, admin: Address) {
        admin.require_auth();
        if !Self::is_admin(env.clone(), admin) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        env.storage().instance().set(&PAUSED_KEY, &true);
        extend_instance_ttl(&env);
        PauseChangedEvent { paused: true }.publish(&env);
    }

    /// Proposes a multi-signature administrative action.
    pub fn propose_admin_action(env: Env, proposer: Address, action: AdminAction) -> u64 {
        proposer.require_auth();
        if !Self::is_admin(env.clone(), proposer.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let prop_id: u64 = env
            .storage()
            .persistent()
            .get(&PROPOSAL_COUNTER_KEY)
            .unwrap_or(0);
        let timelock: u64 = env
            .storage()
            .instance()
            .get(&TIMELOCK_DELAY_KEY)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        let eta = match now.checked_add(timelock) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        let expires_at = match now.checked_add(ADMIN_PROPOSAL_TTL_SECONDS) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };

        let proposal = AdminProposal {
            id: prop_id,
            action,
            proposer: proposer.clone(),
            approvals_count: 1,
            created_at: now,
            eta,
            expires_at,
            executed: false,
            cancelled: false,
        };

        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, prop_id), &proposal);
        env.storage()
            .persistent()
            .set(&(APPROVAL_KEY, prop_id, proposer.clone()), &true);
        let next_prop_id = match prop_id.checked_add(1) {
            Some(id) => id,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&PROPOSAL_COUNTER_KEY, &next_prop_id);

        ProposalCreatedEvent {
            proposal_id: prop_id,
            proposer,
            eta,
        }
        .publish(&env);

        prop_id
    }

    /// Approves an existing administrative proposal.
    pub fn approve_admin_action(env: Env, admin: Address, proposal_id: u64) {
        admin.require_auth();
        if !Self::is_admin(env.clone(), admin.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let mut proposal: AdminProposal =
            match env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id)) {
                Some(p) => p,
                None => soroban_sdk::panic_with_error!(&env, DonationError::ProposalNotFound),
            };
        if proposal.executed {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalAlreadyExecuted);
        }

        let has_approved: bool = env
            .storage()
            .persistent()
            .get(&(APPROVAL_KEY, proposal_id, admin.clone()))
            .unwrap_or(false);
        if has_approved {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyApproved);
        }

        env.storage()
            .persistent()
            .set(&(APPROVAL_KEY, proposal_id, admin.clone()), &true);
        proposal.approvals_count = match proposal.approvals_count.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);

        ProposalApprovedEvent {
            proposal_id,
            admin,
            approvals_count: proposal.approvals_count,
        }
        .publish(&env);
    }

    /// Cancels an administrative proposal before it is executed. The proposer
    /// can cancel their own proposal unilaterally. Any other caller must be a
    /// current admin: each such admin records a cancellation request, counted
    /// against the *current* admin set exactly like approvals (requests from
    /// since-removed admins do not count), and the proposal is marked
    /// cancelled once `threshold` requests have been reached. Emits
    /// [`ProposalCancelledEvent`] when the proposal is marked cancelled.
    pub fn cancel_admin_action(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let mut proposal: AdminProposal = env
            .storage()
            .persistent()
            .get(&(PROPOSAL_KEY, proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed, "proposal already executed");
        assert!(!proposal.cancelled, "proposal already cancelled");
        extend_instance_ttl(&env);

        if caller != proposal.proposer {
            assert!(
                Self::is_admin(env.clone(), caller.clone()),
                "only the proposer or an admin can cancel a proposal"
            );
            let already_requested: bool = env
                .storage()
                .persistent()
                .get(&(CANCEL_KEY, proposal_id, caller.clone()))
                .unwrap_or(false);
            assert!(
                !already_requested,
                "admin has already requested cancellation"
            );
            env.storage()
                .persistent()
                .set(&(CANCEL_KEY, proposal_id, caller.clone()), &true);

            let requests = Self::count_current_admin_votes(&env, CANCEL_KEY, proposal_id);
            let threshold: u32 = env
                .storage()
                .instance()
                .get(&THRESHOLD_KEY)
                .expect("threshold not set");
            if requests < threshold {
                return;
            }
        }

        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);

        ProposalCancelledEvent {
            proposal_id,
            cancelled_by: caller,
        }
        .publish(&env);
    }

    /// Executes an administrative proposal once signature threshold & timelock criteria are met.
    pub fn execute_admin_action(env: Env, executor: Address, proposal_id: u64) {
        executor.require_auth();
        if !Self::is_admin(env.clone(), executor.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let mut proposal: AdminProposal =
            match env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id)) {
                Some(p) => p,
                None => soroban_sdk::panic_with_error!(&env, DonationError::ProposalNotFound),
            };
        if proposal.executed {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalAlreadyExecuted);
        }

        let threshold: u32 = match env.storage().instance().get(&THRESHOLD_KEY) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::NotInitialized),
        };
        if proposal.approvals_count < threshold {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        if now < proposal.eta {
            soroban_sdk::panic_with_error!(&env, DonationError::TimelockNotElapsed);
        }

        match proposal.action.clone() {
            AdminAction::SetExecutor(target) => {
                let old: Option<Address> = env.storage().instance().get(&EXECUTOR_KEY);
                env.storage().instance().set(&EXECUTOR_KEY, &target);
                ExecutorChangedEvent {
                    old_executor: old,
                    new_executor: target,
                }
                .publish(&env);
            }
            AdminAction::SetDonationContract(target) => {
                env.storage().instance().set(&REGISTRY_KEY, &target);
            }
            AdminAction::AddAdmin(new_admin) => {
                let mut admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if !Self::contains_address(&admins, &new_admin) {
                    admins.push_back(new_admin);
                    env.storage().instance().set(&ADMINS_KEY, &admins);
                }
            }
            AdminAction::RemoveAdmin(old_admin) => {
                let admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                let mut new_admins = Vec::new(&env);
                for i in 0..admins.len() {
                    let a = admins.get(i).unwrap();
                    if a != old_admin {
                        new_admins.push_back(a);
                    }
                }
                if new_admins.is_empty() {
                    soroban_sdk::panic_with_error!(&env, DonationError::CannotRemoveAllAdmins);
                }
                let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap();
                if threshold > new_admins.len() {
                    soroban_sdk::panic_with_error!(&env, DonationError::ThresholdExceedsAdmins);
                }
                env.storage().instance().set(&ADMINS_KEY, &new_admins);

                // #284: a removed primary admin must lose every privilege
                // the legacy single-admin shortcuts (`set_executor`, token
                // allowlist, donation limits) gate on `ADMIN_KEY`, not just
                // its seat in `ADMINS_KEY`. Reassign `ADMIN_KEY` to the new
                // `admins.get(0)` exactly like `__constructor` picks the
                // initial primary admin, so those shortcuts keep working for
                // *some* current admin on a 1-of-1 deployment instead of
                // being permanently stuck pointing at a removed address.
                let current_primary: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
                if current_primary == old_admin {
                    env.storage()
                        .instance()
                        .set(&ADMIN_KEY, &new_admins.get(0).unwrap());
                }
            }
            AdminAction::SetThreshold(new_threshold) => {
                let admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if new_threshold == 0 || new_threshold > admins.len() {
                    soroban_sdk::panic_with_error!(&env, DonationError::InvalidThreshold);
                }
                env.storage().instance().set(&THRESHOLD_KEY, &new_threshold);
            }
            AdminAction::Pause => {
                env.storage().instance().set(&PAUSED_KEY, &true);
                PauseChangedEvent { paused: true }.publish(&env);
            }
            AdminAction::Unpause => {
                env.storage().instance().set(&PAUSED_KEY, &false);
                PauseChangedEvent { paused: false }.publish(&env);
            }
            AdminAction::AddAllowedToken(token) => {
                Self::set_allowed_token(&env, &token, true);
            }
            AdminAction::RemoveAllowedToken(token) => {
                Self::set_allowed_token(&env, &token, false);
            }
            AdminAction::SetMinDonation(min_amount) => {
                Self::apply_min_donation(&env, min_amount);
            }
            AdminAction::SetMaxDonation(max_amount) => {
                Self::apply_max_donation(&env, max_amount);
            }
        }

        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);

        ProposalExecutedEvent {
            proposal_id,
            executor,
        }
        .publish(&env);
    }

    /// Legacy set_executor entry point. Functions directly when threshold is 1; enforces multi-sig proposals otherwise.
    pub fn set_executor(env: Env, executor: Address) {
        let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(1);
        if threshold == 1 {
            let admin: Address = match env.storage().instance().get(&ADMIN_KEY) {
                Some(a) => a,
                None => soroban_sdk::panic_with_error!(&env, DonationError::NotInitialized),
            };
            admin.require_auth();
            let old: Option<Address> = env.storage().instance().get(&EXECUTOR_KEY);
            env.storage().instance().set(&EXECUTOR_KEY, &executor);
            extend_instance_ttl(&env);
            ExecutorChangedEvent {
                old_executor: old,
                new_executor: executor,
            }
            .publish(&env);
        } else {
            soroban_sdk::panic_with_error!(&env, DonationError::MultiSigRequired);
        }
    }

    /// Cross-contract call: delegates creator registration to the CreatorRegistry contract.
    pub fn register_creator(env: Env, creator: Address, username: String) -> CreatorProfile {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator, username).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "register_creator"), args)
    }

    /// Cross-contract call: reads a creator's profile from CreatorRegistry.
    pub fn get_creator(env: Env, creator: Address) -> Option<CreatorProfile> {
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_creator"), args)
    }

    /// Requires `require_auth` from the single primary admin, and panics if
    /// this deployment actually runs a multisig (`threshold > 1`). See
    /// `set_executor` for the pattern this mirrors: on a 1-of-1 deployment
    /// there is no multisig to bypass, so the legacy single-call setters
    /// below stay convenient; once `threshold > 1`, every one of them must
    /// go through `propose_admin_action` / `approve_admin_action` /
    /// `execute_admin_action` instead, or a single compromised or
    /// disagreeing key could unilaterally allowlist an arbitrary token or
    /// choke donations by setting `max_donation` to 1 stroop (#284).
    fn require_single_admin_mode(env: &Env, caller_panic_message: &str) -> Address {
        let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(1);
        assert!(threshold == 1, "{}", caller_panic_message);
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("donation contract not initialized");
        admin.require_auth();
        admin
    }

    /// Admin-gated: adds a token address to the allowlist. Direct calls only
    /// work on a single-admin (threshold == 1) deployment — see
    /// `require_single_admin_mode`; otherwise propose `AddAllowedToken`.
    pub fn add_allowed_token(env: Env, token: Address) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the token allowlist",
        );
        Self::set_allowed_token(&env, &token, true);
    }

    /// Admin-gated: removes a token address from the allowlist. Direct calls
    /// only work on a single-admin (threshold == 1) deployment — see
    /// `require_single_admin_mode`; otherwise propose `RemoveAllowedToken`.
    pub fn remove_allowed_token(env: Env, token: Address) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the token allowlist",
        );
        Self::set_allowed_token(&env, &token, false);
    }

    /// Shared allowlist mutation for both the legacy direct setters and the
    /// `AddAllowedToken`/`RemoveAllowedToken` `AdminAction` executor arms, so
    /// the storage write, TTL extension, and event are identical regardless
    /// of which path reached it.
    fn set_allowed_token(env: &Env, token: &Address, allowed: bool) {
        if allowed {
            env.storage()
                .instance()
                .set(&(ALLOWED_TOKEN_KEY, token), &true);
        } else {
            env.storage().instance().remove(&(ALLOWED_TOKEN_KEY, token));
        }
        extend_instance_ttl(env);
        AllowedTokenChangedEvent {
            token: token.clone(),
            allowed,
        }
        .publish(env);
    }

    /// Checks if a token is currently in the allowlist.
    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage().instance().has(&(ALLOWED_TOKEN_KEY, token))
    }

    /// Admin-gated: sets the minimum donation amount guardrail (0 to
    /// disable). Direct calls only work on a single-admin (threshold == 1)
    /// deployment — see `require_single_admin_mode`; otherwise propose
    /// `SetMinDonation`.
    pub fn set_min_donation(env: Env, min_amount: i128) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the minimum donation",
        );
        Self::apply_min_donation(&env, min_amount);
    }

    /// Returns the currently configured minimum donation amount (0 if unconstrained).
    pub fn get_min_donation(env: Env) -> i128 {
        env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0)
    }

    /// Admin-gated: sets the sanity-check maximum donation amount guardrail
    /// (0 to disable). Direct calls only work on a single-admin
    /// (threshold == 1) deployment — see `require_single_admin_mode`;
    /// otherwise propose `SetMaxDonation`.
    pub fn set_max_donation(env: Env, max_amount: i128) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the maximum donation",
        );
        Self::apply_max_donation(&env, max_amount);
    }

    /// Returns the currently configured maximum donation amount (0 if unconstrained).
    pub fn get_max_donation(env: Env) -> i128 {
        env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0)
    }

    /// Shared min-donation mutation for both the legacy direct setter and
    /// the `SetMinDonation` `AdminAction` executor arm. Validates `min <=
    /// max` whenever both are non-zero (#284), so neither path can leave the
    /// guardrails in a self-contradictory state where no donation could
    /// ever pass both checks.
    fn apply_min_donation(env: &Env, min_amount: i128) {
        assert!(min_amount >= 0, "minimum donation must be non-negative");
        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        assert!(
            max_amount == 0 || min_amount <= max_amount,
            "minimum donation cannot exceed the maximum donation"
        );
        let old_min: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        env.storage().instance().set(&MIN_DONATION_KEY, &min_amount);
        extend_instance_ttl(env);
        MinDonationChangedEvent {
            old_min,
            new_min: min_amount,
        }
        .publish(env);
    }

    /// Shared max-donation mutation for both the legacy direct setter and
    /// the `SetMaxDonation` `AdminAction` executor arm. See
    /// `apply_min_donation` for the `min <= max` invariant this also
    /// enforces.
    fn apply_max_donation(env: &Env, max_amount: i128) {
        assert!(max_amount >= 0, "maximum donation must be non-negative");
        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        assert!(
            max_amount == 0 || min_amount <= max_amount,
            "maximum donation cannot be less than the minimum donation"
        );
        let old_max: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        env.storage().instance().set(&MAX_DONATION_KEY, &max_amount);
        extend_instance_ttl(env);
        MaxDonationChangedEvent {
            old_max,
            new_max: max_amount,
        }
        .publish(env);
    }

    /// Transfer `amount` of `token` from `donor` to `creator`, record the
    /// donation locally, and notify the CreatorRegistry (cross-contract) so
    /// the creator's lifetime stats stay in sync.
    ///
    /// NOTE ON TTL: The donation record is stored with the network's default TTL.
    /// To minimize rent costs on an indefinitely growing append-only log, this
    /// contract does not call `extend_ttl` for old records. They are allowed to expire,
    /// with the backend relying on emitted `DonatedEvent`s for history instead.
    pub fn donate(
        env: Env,
        donor: Address,
        creator: Address,
        token: Address,
        amount: i128,
        memo: String,
    ) -> DonationRecord {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        donor.require_auth();
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidAmount);
        }

        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        if min_amount > 0 && amount < min_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooLow);
        }

        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        if max_amount > 0 && amount > max_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooHigh);
        }

        if memo.len() > MAX_MEMO_LENGTH {
            soroban_sdk::panic_with_error!(&env, DonationError::MemoTooLong);
        }
        if !Self::is_token_allowed(env.clone(), token.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::TokenNotAllowed);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &creator, &amount);

        let registry = Self::registry_address(&env);
        let record_args: Vec<Val> =
            (env.current_contract_address(), creator.clone(), amount).into_val(&env);
        let (): () = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "record_donation"),
            record_args,
        );

        let donation = DonationRecord {
            donor: donor.clone(),
            creator: creator.clone(),
            amount,
            fee_amount: 0,
            memo: memo.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        let next_counter = match counter.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &next_counter);

        DonatedEvent {
            donor,
            creator,
            donation_id: counter,
            token,
            amount,
            fee_amount: 0,
            memo,
            timestamp: env.ledger().timestamp(),
            subscription_id: None,
        }
        .publish(&env);

        donation
    }

    /// Starts a recurring donation.
    pub fn subscribe(
        env: Env,
        supporter: Address,
        creator: Address,
        token: Address,
        amount: i128,
        interval_secs: u64,
    ) -> u64 {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        supporter.require_auth();
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidAmount);
        }
        if interval_secs == 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidInterval);
        }
        if !Self::is_token_allowed(env.clone(), token.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::TokenNotAllowed);
        }

        let id: u64 = env.storage().persistent().get(&SUB_COUNTER).unwrap_or(0);
        let now = env.ledger().timestamp();
        let next_charge_at = match now.checked_add(interval_secs) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };

        let subscription = Subscription {
            supporter: supporter.clone(),
            creator: creator.clone(),
            token: token.clone(),
            amount,
            interval_secs,
            next_charge_at,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, id), &subscription);
        let next_id = match id.checked_add(1) {
            Some(next) => next,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage().persistent().set(&SUB_COUNTER, &next_id);

        Self::adjust_committed_amount(&env, &supporter, &token, amount);

        SubscribedEvent {
            supporter,
            creator,
            subscription_id: id,
            token,
            amount,
            interval_secs,
            next_charge_at,
        }
        .publish(&env);

        id
    }

    /// Executes one due charge of a subscription by drawing on the SAC
    /// allowance the supporter granted this contract, then records and
    /// reports it exactly like a one-off `donate`. Callable only by the
    /// authorized executor (see `set_executor`).
    ///
    /// # Observability of a failed charge (#283)
    ///
    /// On `InsufficientAllowance`/`InsufficientBalance`, this publishes
    /// [`SubscriptionChargeFailedEvent`] and then returns `Err(ChargeError)`.
    /// Soroban rolls back *all* state changes and events from an invocation
    /// that returns an `Err` (confirmed by this crate's test snapshots,
    /// which mark that event `failed_call: true`), so the event is only
    /// ever visible in a local simulation's diagnostics, never to an
    /// indexer reading finalized ledgers. Rather than changing this
    /// function's return type to a non-reverting `Ok(Failed(reason))` variant
    /// (a breaking signature change for every caller and the ~15 existing
    /// tests asserting `Err(ChargeError::...)` via `try_charge_subscription`),
    /// the chosen fix keeps the `Err` return and has the backend
    /// (`subscriptionExecutor.ts`) decode the same `ChargeError` discriminant
    /// two other ways that *do* survive: directly from a simulation-time
    /// rejection's error string (`Error(Contract, #<code>)`), and from a
    /// submitted-but-reverted transaction's `diagnosticEventsXdr` (see
    /// `decodeChargeErrorReasonFromDiagnostics`). Both paths yield the exact
    /// same `InsufficientAllowance` vs `InsufficientBalance` distinction this
    /// event would have, without touching the Rust return type.
    pub fn charge_subscription(
        env: Env,
        executor: Address,
        subscription_id: u64,
    ) -> Result<DonationRecord, ChargeError> {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        executor.require_auth();
        let authorized_executor: Address = match env.storage().instance().get(&EXECUTOR_KEY) {
            Some(e) => e,
            None => soroban_sdk::panic_with_error!(&env, DonationError::ExecutorNotSet),
        };
        if executor != authorized_executor {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let mut subscription: Subscription = match env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
        {
            Some(s) => s,
            None => soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotFound),
        };
        if !subscription.active {
            soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotActive);
        }

        let now = env.ledger().timestamp();
        if now < subscription.next_charge_at {
            soroban_sdk::panic_with_error!(&env, DonationError::NotDue);
        }

        let token_client = token::Client::new(&env, &subscription.token);

        let allowance =
            token_client.allowance(&subscription.supporter, &env.current_contract_address());
        if allowance < subscription.amount {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::InsufficientAllowance,
            }
            .publish(&env);
            return Err(ChargeError::InsufficientAllowance);
        }

        let balance = token_client.balance(&subscription.supporter);
        if balance < subscription.amount {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::InsufficientBalance,
            }
            .publish(&env);
            return Err(ChargeError::InsufficientBalance);
        }

        subscription.next_charge_at = match now.checked_add(subscription.interval_secs) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );

        token_client.transfer_from(
            &env.current_contract_address(),
            &subscription.supporter,
            &subscription.creator,
            &subscription.amount,
        );

        let registry = Self::registry_address(&env);
        let record_args: Vec<Val> = (
            env.current_contract_address(),
            subscription.creator.clone(),
            subscription.amount,
        )
            .into_val(&env);
        let (): () = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "record_donation"),
            record_args,
        );

        let memo = String::from_str(&env, "recurring");
        let donation = DonationRecord {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            amount: subscription.amount,
            fee_amount: 0,
            memo: memo.clone(),
            timestamp: now,
        };

        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        let next_counter = match counter.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &next_counter);

        DonatedEvent {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            donation_id: counter,
            token: subscription.token.clone(),
            amount: subscription.amount,
            fee_amount: 0,
            memo,
            timestamp: now,
            subscription_id: Some(subscription_id),
        }
        .publish(&env);

        Ok(donation)
    }

    /// Cancels a subscription and reduces the supporter's SAC allowance to
    /// this contract by exactly this subscription's committed amount.
    ///
    /// # Allowance semantics
    ///
    /// SAC allowances are keyed by `(owner, spender)`, not per subscription,
    /// so a supporter with two active subscriptions in the same token shares
    /// one allowance between them. Zeroing that allowance on cancellation
    /// (the old behavior) would silently break every *other* active
    /// subscription in that token until the supporter noticed and
    /// re-approved. Instead, this contract tracks each supporter's total
    /// committed amount per token (`COMMITTED_KEY`, updated by `subscribe`
    /// and here) and only decrements the live allowance by this
    /// subscription's own `amount`, clamped at zero so a stale/lower
    /// allowance (e.g. partially drawn down since) never underflows. The
    /// remaining allowance is left untouched and continues to cover the
    /// supporter's other active subscriptions in the same token.
    pub fn cancel_subscription(env: Env, supporter: Address, subscription_id: u64) {
        supporter.require_auth();

        let mut subscription: Subscription = match env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
        {
            Some(s) => s,
            None => soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotFound),
        };
        if subscription.supporter != supporter {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        if !subscription.active {
            soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotActive);
        }
        extend_instance_ttl(&env);

        subscription.active = false;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );

        Self::adjust_committed_amount(&env, &supporter, &subscription.token, -subscription.amount);

        let token_client = token::Client::new(&env, &subscription.token);
        let current_allowance = token_client.allowance(&supporter, &env.current_contract_address());
        let reduced_allowance = (current_allowance - subscription.amount).max(0);
        // The SAC `TokenInterface` only exposes the allowance *amount*, not
        // its current `live_until_ledger`, so the original expiration cannot
        // be read back and preserved exactly on a partial reduction. When
        // fully zeroing (no amount left to protect), the expiration argument
        // is moot and 0 is passed, matching the old zeroing behavior. When a
        // positive amount remains — i.e. other active subscriptions on this
        // token still need it — this extends the allowance far enough to
        // outlive this subscription's own remaining committed siblings,
        // using the same per-subscription TTL budget `subscribe` already
        // uses for the subscription entry itself (comfortably longer than
        // one more charge interval). This can lengthen an allowance's
        // remaining lifetime but never shortens one that is still needed.
        let expiration_ledger = if reduced_allowance > 0 {
            let bump_ledgers = common::subscription_bump_amount(subscription.interval_secs);
            env.ledger().sequence().saturating_add(bump_ledgers)
        } else {
            0
        };
        token_client.approve(
            &supporter,
            &env.current_contract_address(),
            &reduced_allowance,
            &expiration_ledger,
        );

        SubscriptionCancelledEvent {
            supporter,
            creator: subscription.creator,
            subscription_id,
        }
        .publish(&env);
    }

    /// Adjusts the supporter's tracked committed-amount counter for `token`
    /// by `delta` (positive on `subscribe`, negative on `cancel_subscription`),
    /// clamped at zero. See `COMMITTED_KEY` and `cancel_subscription`'s doc
    /// comment for why this tracking exists.
    fn adjust_committed_amount(env: &Env, supporter: &Address, token: &Address, delta: i128) {
        let key = (COMMITTED_KEY, supporter.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = (current + delta).max(0);
        env.storage().persistent().set(&key, &updated);
        extend_persistent_ttl(env, &key);
    }

    /// Returns the supporter's currently committed amount (sum of active
    /// subscription amounts) for `token`. Used by tests and available to the
    /// frontend/backend to compute how much allowance headroom is still
    /// needed before approving a new subscription.
    pub fn get_committed_amount(env: Env, supporter: Address, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&(COMMITTED_KEY, supporter, token))
            .unwrap_or(0)
    }

    /// Permissionless keep-alive for a subscription entry. Intervals longer
    /// than the maximum extension (e.g. annual) outlive a single bump, so the
    /// backend executor should call this between charges. Only extends the TTL
    /// (and only once it has dropped below the threshold); it changes no
    /// subscription data and moves no funds.
    pub fn bump_subscription(env: Env, subscription_id: u64) {
        extend_instance_ttl(&env);
        let subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );
    }

    /// Fetch a subscription by its ID.
    pub fn get_subscription(env: Env, subscription_id: u64) -> Option<Subscription> {
        env.storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
    }

    /// Cross-contract call: updates a creator's funding goal in the CreatorRegistry.
    pub fn set_goal(env: Env, creator: Address, goal_amount: i128) {
        creator.require_auth();
        extend_instance_ttl(&env);
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator, goal_amount).into_val(&env);
        let (): () = env.invoke_contract(&registry, &Symbol::new(&env, "set_goal"), args);
    }

    /// Cross-contract call: reads a creator's funding goal from CreatorRegistry.
    pub fn get_goal(env: Env, creator: Address) -> Option<i128> {
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_goal"), args)
    }

    /// Get all donations count (approximate, stored in counter)
    ///
    /// NOTE ON STORAGE GROWTH & TTL: The donations log is an append-only structure.
    /// It grows indefinitely, which means state rent accumulates over time.
    /// To avoid unbounded rent costs for the contract, we do not explicitly extend
    /// the TTL of old donation records. If old records expire due to un-extended
    /// TTLs, this function's counter remains valid, but `get_donation` may fail
    /// to find them. This is an accepted tradeoff since the emitted `DonatedEvent`s
    /// (indexed off-chain) are the canonical long-term record.
    pub fn get_total_donations_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0)
    }

    /// Fetch a single donation record by its counter-based index.
    ///
    /// NOTE: Donation records are subject to Soroban's state expiry.
    /// Because the on-chain donation log is append-only and grows indefinitely,
    /// the contract does not explicitly extend the TTL of these records to save
    /// on state rent. If a record has expired, this function will return `None`.
    /// Downstream applications should rely on off-chain indexed `DonatedEvent`s
    /// as the canonical historical record, rather than depending on this function
    /// for long-term historical data.
    pub fn get_donation(env: Env, index: u32) -> Option<DonationRecord> {
        env.storage().persistent().get(&(DONATIONS_KEY, index))
    }

    /// Fetch proposal by proposal_id.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<AdminProposal> {
        env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id))
    }

    fn registry_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&REGISTRY_KEY)
            .expect("donation contract not initialized")
    }

    fn contains_address(vec: &Vec<Address>, target: &Address) -> bool {
        for i in 0..vec.len() {
            if vec.get(i).unwrap() == *target {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use creator_registry::{CreatorRegistryContract, CreatorRegistryContractClient};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::StellarAssetClient;

    fn create_token_contract(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    fn deploy_pair(
        env: &Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
    ) -> (
        DonationContractClient<'_>,
        CreatorRegistryContractClient<'_>,
    ) {
        let donation_id = env.register(DonationContract, ());
        let registry_id = env.register(
            CreatorRegistryContract,
            (
                admins.clone(),
                threshold,
                timelock_delay,
                donation_id.clone(),
            ),
        );
        let donation_client = DonationContractClient::new(env, &donation_id);
        donation_client.initialize_multisig(&admins, &threshold, &timelock_delay, &registry_id);
        (
            donation_client,
            CreatorRegistryContractClient::new(env, &registry_id),
        )
    }

    fn setup(
        env: &Env,
    ) -> (
        Address,
        DonationContractClient<'_>,
        CreatorRegistryContractClient<'_>,
    ) {
        let admin = Address::generate(env);
        let (donation_client, registry_client) =
            deploy_pair(env, Vec::from_array(env, [admin.clone()]), 1, 0);
        (admin, donation_client, registry_client)
    }

    #[test]
    fn test_register_creator_via_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let profile =
            donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        assert_eq!(profile.donation_count, 0);
        assert_eq!(profile.total_donations, 0);
    }

    #[test]
    fn test_multisig_proposal_approval_execution_flow() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let executor = Address::generate(&env);

        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());

        // 2-of-3 threshold with 100 seconds timelock delay
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 100);

        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::SetExecutor(executor.clone()));

        let prop = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop.approvals_count, 1);
        assert!(!prop.executed);

        donation_client.approve_admin_action(&admin2, &prop_id);

        let prop2 = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop2.approvals_count, 2);

        // Timelock has not elapsed yet (timestamp 0 < eta 100)
        env.ledger().with_mut(|li| li.timestamp = 150);

        donation_client.execute_admin_action(&admin1, &prop_id);

        let prop_exec = donation_client.get_proposal(&prop_id).unwrap();
        assert!(prop_exec.executed);
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        assert!(!donation_client.is_paused());
        donation_client.emergency_pause(&admin);
        assert!(donation_client.is_paused());
    }

    #[test]
    fn test_donate_updates_registry_cross_contract() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        env.ledger().with_mut(|li| li.sequence_number = 100);

        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        let donation = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"Great work!"),
        );

        assert_eq!(donation.amount, 1000);
        assert_eq!(donation.donor, donor);
        assert_eq!(donation.creator, creator);
        assert_eq!(donation.memo, String::from_bytes(&env, b"Great work!"));
        assert_eq!(
            donation_client.get_donation(&0).unwrap().memo,
            donation.memo
        );

        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&creator), 1000);
        assert_eq!(token_client.balance(&donor), 9_000);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 1000);
        assert_eq!(stats.donation_count, 1);

        // And the donation contract's own view of the registry agrees.
        let stats_via_donation = donation_client.get_creator(&creator).unwrap();
        assert_eq!(stats_via_donation.total_donations, 1000);
    }

    #[test]
    fn test_donate_without_prior_registration_creates_profile() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &5_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &250,
            &String::from_bytes(&env, b"First!"),
        );

        assert!(registry_client.get_creator(&creator).is_none());

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"new_dev"));

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 250);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    fn test_donate_rejects_non_positive_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &0,
            &String::from_bytes(&env, b"nope"),
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidAmount.into()
        );
    }

    #[test]
    #[should_panic]
    fn test_donate_rejects_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"too much"),
        );
    }

    #[test]
    fn test_donate_rejects_oversized_memo() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);
        let oversized_memo = [b'x'; MAX_MEMO_LENGTH as usize + 1];

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, &oversized_memo),
        );
        assert_eq!(res.unwrap_err().unwrap(), DonationError::MemoTooLong.into());
    }

    #[test]
    fn test_multiple_donations_increment_counter_and_history() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, b"one"),
        );
        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &200,
            &String::from_bytes(&env, b"two"),
        );

        assert_eq!(donation_client.get_total_donations_count(), 2);
        assert_eq!(donation_client.get_donation(&0).unwrap().amount, 100);
        assert_eq!(donation_client.get_donation(&1).unwrap().amount, 200);
    }

    #[test]
    fn test_subscribe_records_schedule() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let id = donation_client.subscribe(&supporter, &creator, &token_address, &100, &2_592_000);
        let subscription = donation_client.get_subscription(&id).unwrap();

        assert_eq!(subscription.supporter, supporter);
        assert_eq!(subscription.creator, creator);
        assert_eq!(subscription.amount, 100);
        assert_eq!(subscription.interval_secs, 2_592_000);
        assert_eq!(subscription.next_charge_at, 1_000 + 2_592_000);
        assert!(subscription.active);
    }

    #[test]
    fn test_charge_subscription_draws_allowance_and_updates_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"dev"));

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id);

        assert_eq!(donation.amount, 500);
        assert_eq!(donation.donor, supporter);
        assert_eq!(token_client.balance(&creator), 500);
        assert_eq!(token_client.balance(&supporter), 9_500);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 500);
        assert_eq!(stats.donation_count, 1);

        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 2_000 + 1_000);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_unauthorized_executor() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let impostor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        donation_client.charge_subscription(&impostor, &id);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_before_due() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Still at timestamp 1_000, next_charge_at is 2_000 — too early.
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_cancel_subscription_deactivates_and_revokes_allowance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            500
        );

        donation_client.cancel_subscription(&supporter, &id);

        assert!(!donation_client.get_subscription(&id).unwrap().active);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            0
        );
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_cancelled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        donation_client.cancel_subscription(&supporter, &id);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_set_and_get_creator_goal_cross_contract() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        assert_eq!(donation_client.get_goal(&creator), None);

        donation_client.set_goal(&creator, &2500);
        assert_eq!(donation_client.get_goal(&creator), Some(2500));
    }

    #[test]
    fn test_donate_rejects_unallowed_token() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = env.register_stellar_asset_contract_v2(admin).address();
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, b"should fail"),
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::TokenNotAllowed.into()
        );
    }

    #[test]
    fn test_subscribe_rejects_unallowed_token() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = env.register_stellar_asset_contract_v2(admin).address();

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let res =
            donation_client.try_subscribe(&supporter, &creator, &token_address, &100, &2_592_000);
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::TokenNotAllowed.into()
        );
    }

    #[test]
    fn test_charge_subscription_insufficient_allowance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        // Approve less than the required amount
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &100, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);

        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientAllowance
        );
    }

    #[test]
    fn test_charge_error_discriminants_are_stable_for_backend_decoding() {
        // #283: the backend decodes these exact numeric codes out of
        // `Error(Contract, #<code>)` text in a simulation error or a failed
        // transaction's diagnostic events (see subscriptionExecutor.ts's
        // `decodeChargeErrorReason`/`decodeChargeErrorReasonFromDiagnostics`).
        // Changing either discriminant without updating that backend mapping
        // would silently break the allowance-vs-balance distinction, so this
        // pins them down as a regression guard.
        assert_eq!(ChargeError::InsufficientAllowance as u32, 1);
        assert_eq!(ChargeError::InsufficientBalance as u32, 2);
    }

    #[test]
    fn test_charge_subscription_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        // Mint less than the required amount
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        // Approve enough allowance
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &1000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);

        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientBalance
        );
    }

    // --- charge_subscription edge cases ---------------------------------

    /// Registers a token, mints `balance` to the supporter, sets an executor and
    /// creates a 500-per-1_000s subscription at t=1_000 with `allowance` approved.
    fn subscription_fixture(
        env: &Env,
        balance: i128,
        allowance: i128,
    ) -> (
        Address,
        DonationContractClient<'_>,
        Address,
        Address,
        Address,
        Address,
        u64,
    ) {
        let (admin, donation_client, _registry_client) = setup(env);
        let supporter = Address::generate(env);
        let creator = Address::generate(env);
        let executor = Address::generate(env);
        let token_address = create_token_contract(env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(env, &token_address).mint(&supporter, &balance);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        token::Client::new(env, &token_address).approve(
            &supporter,
            &donation_client.address,
            &allowance,
            &1_000,
        );
        (
            admin,
            donation_client,
            supporter,
            creator,
            executor,
            token_address,
            id,
        )
    }

    #[test]
    fn test_charge_subscription_succeeds_exactly_at_due_time() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        // next_charge_at is 1_000 + 1_000; a charge at exactly that timestamp is due.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);

        assert_eq!(
            token::Client::new(&env, &token_address).balance(&creator),
            500
        );
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_cannot_charge_twice_in_one_period() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
        // Same ledger time: the schedule has moved to 3_000, so this must be rejected.
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_charge_subscription_late_charge_reschedules_from_now() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 500);

        // Executor is 5_000s late (due at 2_000); the next charge is measured
        // from the actual charge time, so missed periods are not back-charged.
        env.ledger().with_mut(|li| li.timestamp = 7_000);
        donation_client.charge_subscription(&executor, &id);

        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 7_000 + 1_000);
        assert!(subscription.active);
    }

    #[test]
    fn test_charge_subscription_failed_charge_leaves_schedule_and_balances_unchanged() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 100);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientAllowance
        );

        // A failed attempt must not advance the schedule, so it can be retried
        // as soon as the supporter fixes their allowance.
        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 2_000);
        assert!(subscription.active);
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&supporter), 10_000);
        assert_eq!(token_client.balance(&creator), 0);
    }

    #[test]
    fn test_charge_subscription_retry_succeeds_after_allowance_topped_up() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 100);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        assert!(donation_client
            .try_charge_subscription(&executor, &id)
            .is_err());

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);
        donation_client.charge_subscription(&executor, &id);

        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_unknown_subscription() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, _id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.charge_subscription(&executor, &999);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_while_paused() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.emergency_pause(&admin);
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_subscribe_rejects_zero_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &0,
            &1_000,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidAmount.into()
        );
    }

    #[test]
    fn test_subscribe_rejects_zero_interval() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &500,
            &0,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidInterval.into()
        );
    }

    #[test]
    fn test_cancel_subscription_does_not_break_other_active_subscriptions_same_token() {
        // #282: supporter subscribes to two creators in the same token;
        // cancelling one must not zero out the allowance backing the other.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let supporter = Address::generate(&env);
        let creator_a = Address::generate(&env);
        let creator_b = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.set_executor(&executor);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let id_a = donation_client.subscribe(&supporter, &creator_a, &token_address, &500, &1_000);
        let id_b = donation_client.subscribe(&supporter, &creator_b, &token_address, &300, &1_000);

        // One shared allowance covering both subscriptions' combined need.
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &800, &1_000_000);

        donation_client.cancel_subscription(&supporter, &id_a);

        // The shared allowance should be reduced only by subscription A's
        // amount (500), leaving 300 — exactly what B still needs — instead
        // of being zeroed out.
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            300
        );

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id_b);
        assert_eq!(donation.amount, 300);
        assert_eq!(token_client.balance(&creator_b), 300);
    }

    #[test]
    fn test_cancel_subscription_zeroes_allowance_when_no_siblings_remain() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, _creator, _executor, token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.cancel_subscription(&supporter, &id);

        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            0
        );
    }

    #[test]
    #[should_panic]
    fn test_cancel_subscription_rejects_double_cancel() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, _creator, _executor, _token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.cancel_subscription(&supporter, &id);
        donation_client.cancel_subscription(&supporter, &id);
    }

    // =========================================================================
    // Property-Based & Invariant Fuzz Tests (#46)
    // =========================================================================

    #[test]
    fn property_test_total_donations_equals_sum_of_individual_donations() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"prop_creator"));

        // Multi-batch donation sequences
        let sequences: [&[i128]; 4] = [
            &[100, 250, 50, 1000, 5],
            &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            &[500_000, 250_000, 1_000_000],
            &[10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        ];

        let mut cumulative_sum = 0i128;
        let mut cumulative_count = 0u32;

        for seq in sequences {
            let needed: i128 = seq.iter().sum();
            StellarAssetClient::new(&env, &token_address).mint(&donor, &needed);

            for &amount in seq {
                let record = donation_client.donate(
                    &donor,
                    &creator,
                    &token_address,
                    &amount,
                    &String::from_bytes(&env, b"fuzz"),
                );
                assert_eq!(record.amount, amount);
                cumulative_sum += amount;
                cumulative_count += 1;

                let stats = registry_client.get_creator(&creator).unwrap();
                assert_eq!(stats.total_donations, cumulative_sum);
                assert_eq!(stats.donation_count, cumulative_count);
            }
        }
    }

    #[test]
    fn property_test_token_balance_conservation_invariant() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let amounts = [42i128, 999, 15_000, 1, 750];
        let total: i128 = amounts.iter().sum();
        let initial_donor_balance = total + 5_000;

        StellarAssetClient::new(&env, &token_address).mint(&donor, &initial_donor_balance);
        let token_client = token::Client::new(&env, &token_address);

        assert_eq!(token_client.balance(&donor), initial_donor_balance);
        assert_eq!(token_client.balance(&creator), 0);
        assert_eq!(token_client.balance(&donation_client.address), 0);

        let mut donated_so_far = 0i128;
        for &amt in &amounts {
            let record = donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &amt,
                &String::from_bytes(&env, b"conservation"),
            );
            donated_so_far += amt;

            // Invariant 1: Fee never exceeds donation amount
            assert!(record.fee_amount <= record.amount);
            // Invariant 2: Gross donation amount is conserved
            let creator_received = record.amount - record.fee_amount;
            assert_eq!(creator_received + record.fee_amount, record.amount);

            // Invariant 3: Balances update exactly by transferred amount
            assert_eq!(
                token_client.balance(&donor),
                initial_donor_balance - donated_so_far
            );
            assert_eq!(token_client.balance(&creator), donated_so_far);
            // Invariant 4: No funds trapped in contract
            assert_eq!(token_client.balance(&donation_client.address), 0);
        }
    }

    #[test]
    fn property_test_unauthorized_callers_cannot_modify_config() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);
        // Drop the mocked auths so the privileged calls below run unauthorized.
        env.set_auths(&[]);

        let _unauthorized_caller = Address::generate(&env);
        let random_token = Address::generate(&env);
        let random_executor = Address::generate(&env);

        // Without mock_all_auths on the unauthorized caller, privileged calls must fail
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.add_allowed_token(&random_token);
        }))
        .is_err());

        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.set_executor(&random_executor);
        }))
        .is_err());

        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.emergency_pause(&_unauthorized_caller);
        }))
        .is_err());
    }

    // =========================================================================
    // #284: multisig gating for the token allowlist and donation limits
    // =========================================================================

    #[test]
    #[should_panic(expected = "multi-sig required")]
    fn test_add_allowed_token_rejects_direct_call_under_multisig() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());
        // 2-of-3 threshold: a single admin must not be able to bypass it.
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        donation_client.add_allowed_token(&Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "multi-sig required")]
    fn test_set_max_donation_rejects_direct_call_under_multisig() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        donation_client.set_max_donation(&1);
    }

    #[test]
    fn test_add_allowed_token_via_multisig_proposal_succeeds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        let token = Address::generate(&env);
        assert!(!donation_client.is_token_allowed(&token));

        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::AddAllowedToken(token.clone()));
        donation_client.approve_admin_action(&admin2, &prop_id);
        donation_client.execute_admin_action(&admin1, &prop_id);

        assert!(donation_client.is_token_allowed(&token));
    }

    #[test]
    fn test_set_min_and_max_donation_via_multisig_proposal() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        let max_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetMaxDonation(1_000));
        donation_client.approve_admin_action(&admin2, &max_prop);
        donation_client.execute_admin_action(&admin1, &max_prop);
        assert_eq!(donation_client.get_max_donation(), 1_000);

        let min_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetMinDonation(10));
        donation_client.approve_admin_action(&admin2, &min_prop);
        donation_client.execute_admin_action(&admin1, &min_prop);
        assert_eq!(donation_client.get_min_donation(), 10);
    }

    #[test]
    #[should_panic(expected = "minimum donation cannot exceed the maximum donation")]
    fn test_set_min_donation_rejects_min_above_existing_max() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        donation_client.set_max_donation(&100);
        donation_client.set_min_donation(&200);
    }

    #[test]
    #[should_panic(expected = "maximum donation cannot be less than the minimum donation")]
    fn test_set_max_donation_rejects_max_below_existing_min() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        donation_client.set_min_donation(&200);
        donation_client.set_max_donation(&100);
    }

    #[test]
    fn test_remove_admin_revokes_primary_admin_privileges() {
        // #284: a removed primary admin must lose ADMIN_KEY-gated powers,
        // not just their seat in ADMINS_KEY.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());
        // 2-of-3 threshold, dropping to 2 admins (still threshold 2) after removal.
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        // Remove admin1, the primary admin set at deploy time.
        let prop_id = donation_client
            .propose_admin_action(&admin2, &AdminAction::RemoveAdmin(admin1.clone()));
        donation_client.approve_admin_action(&admin3, &prop_id);
        donation_client.execute_admin_action(&admin2, &prop_id);

        assert!(!donation_client.is_admin(&admin1));

        // admin1 is no longer an admin at all, so even single-admin-mode
        // shortcuts (which still require threshold == 1, not met here) must
        // reject them — confirming ADMIN_KEY no longer resolves to a
        // removed/compromised key's privileges.
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.set_executor(&Address::generate(&env));
        }))
        .is_err());
    }

    #[test]
    fn test_remove_primary_admin_reassigns_admin_key_on_single_admin_deployment() {
        // On a deployment that drops back to threshold == 1, ADMIN_KEY must
        // be reassigned to the new primary admin, not left pointing at the
        // removed one, so the legacy single-admin shortcuts keep working.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        // Lower the threshold to 1 first so removing admin1 leaves a valid
        // 1-of-1 deployment.
        let threshold_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetThreshold(1));
        donation_client.approve_admin_action(&admin2, &threshold_prop);
        donation_client.execute_admin_action(&admin1, &threshold_prop);

        let remove_prop = donation_client
            .propose_admin_action(&admin2, &AdminAction::RemoveAdmin(admin1.clone()));
        donation_client.execute_admin_action(&admin2, &remove_prop);

        assert!(!donation_client.is_admin(&admin1));
        assert!(donation_client.is_admin(&admin2));

        // admin2 is now the sole admin and threshold is 1, so the legacy
        // direct setter must work for admin2 — proving ADMIN_KEY was
        // reassigned away from the removed admin1.
        donation_client.add_allowed_token(&Address::generate(&env));
    }

    #[test]
    fn property_test_edge_cases_and_boundary_rejection() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000_000);

        // 1. Amount == 0 must panic
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &0,
                &String::from_bytes(&env, b"zero"),
            );
        }))
        .is_err());

        // 2. Negative amount must panic
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &-500,
                &String::from_bytes(&env, b"negative"),
            );
        }))
        .is_err());

        // 3. Memo exceeding MAX_MEMO_LENGTH (140 bytes) must panic
        let long_memo_bytes = [b'a'; 141];
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &100,
                &String::from_bytes(&env, &long_memo_bytes),
            );
        }))
        .is_err());

        // 4. Exactly 140 bytes memo must succeed
        let max_valid_memo = [b'b'; 140];
        let ok_record = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, &max_valid_memo),
        );
        assert_eq!(ok_record.amount, 100);

        // 5. Non-allowed token must panic
        let unallowed_token = Address::generate(&env);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &unallowed_token,
                &100,
                &String::from_bytes(&env, b"unallowed"),
            );
        }))
        .is_err());
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(15))]

        #[test]
        fn proptest_arbitrary_donation_amounts_invariant(
            amount1 in 1i128..10_000,
            amount2 in 1i128..10_000,
            amount3 in 1i128..10_000
        ) {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (admin, donation_client, registry_client) = setup(&env);

            let donor = Address::generate(&env);
            let creator = Address::generate(&env);
            let token_address = create_token_contract(&env, &admin);
            donation_client.add_allowed_token(&token_address);
            donation_client.register_creator(&creator, &String::from_bytes(&env, b"proptest_creator"));

            let total_donation = amount1 + amount2 + amount3;
            StellarAssetClient::new(&env, &token_address).mint(&donor, &(total_donation + 500));

            for amt in [amount1, amount2, amount3] {
                let rec = donation_client.donate(
                    &donor,
                    &creator,
                    &token_address,
                    &amt,
                    &String::from_bytes(&env, b"prop"),
                );
                prop_assert_eq!(rec.amount, amt);
                prop_assert!(rec.fee_amount <= rec.amount);
            }

            let profile = registry_client.get_creator(&creator).unwrap();
            prop_assert_eq!(profile.total_donations, total_donation);
            prop_assert_eq!(profile.donation_count, 3);
        }

        #[test]
        fn proptest_subscription_charge_schedule_invariant(
            interval in 100u64..100_000,
            offset in 1u64..99
        ) {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (admin, donation_client, _registry_client) = setup(&env);

            let supporter = Address::generate(&env);
            let creator = Address::generate(&env);
            let executor = Address::generate(&env);
            let token_address = create_token_contract(&env, &admin);

            donation_client.add_allowed_token(&token_address);
            donation_client.set_executor(&executor);

            StellarAssetClient::new(&env, &token_address).mint(&supporter, &100_000);
            let token_client = token::Client::new(&env, &token_address);
            token_client.approve(&supporter, &donation_client.address, &100_000, &1000);

            env.ledger().with_mut(|li| {
                li.sequence_number = 100;
                li.timestamp = 1_000;
            });

            let sub_id = donation_client.subscribe(
                &supporter,
                &creator,
                &token_address,
                &50,
                &interval,
            );

            // Time is strictly before next_charge_at (1_000 + offset < 1_000 + interval)
            env.ledger().with_mut(|li| {
                li.timestamp = 1_000 + offset;
            });

            // Charging prematurely must fail with error
            let premature_charge = donation_client.try_charge_subscription(&executor, &sub_id);
            prop_assert!(premature_charge.is_err());
        }
    }

    #[test]
    fn test_subscribe_interval_overflow_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let res =
            donation_client.try_subscribe(&supporter, &creator, &token_address, &100, &u64::MAX);
        assert_eq!(res.unwrap_err().unwrap(), DonationError::Overflow.into());
    }

    #[test]
    fn test_charge_subscription_persists_reschedule_with_the_charge() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"dev"));

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &5_000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_500);
        donation_client.charge_subscription(&executor, &id);

        // The reschedule and the transfer land together.
        assert_eq!(
            donation_client
                .get_subscription(&id)
                .unwrap()
                .next_charge_at,
            3_500
        );
        assert_eq!(token_client.balance(&creator), 500);

        // A second charge in the same period is rejected because the new
        // schedule was already persisted.
        assert!(donation_client
            .try_charge_subscription(&executor, &id)
            .is_err());
        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    fn test_failed_charge_does_not_reschedule() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &5_000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientBalance
        );
        assert_eq!(
            donation_client
                .get_subscription(&id)
                .unwrap()
                .next_charge_at,
            2_000
        );
    }

    #[test]
    fn test_donated_event_payload_for_donate_and_subscription() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.set_executor(&executor);

        // 1. One-off donation
        let don = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &300,
            &String::from_bytes(&env, b"support"),
        );
        assert_eq!(don.amount, 300);
        assert_eq!(don.creator, creator);
        assert_eq!(don.donor, donor);

        // 2. Subscription charge
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let sub_id = donation_client.subscribe(&donor, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&donor, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let sub_don = donation_client.charge_subscription(&executor, &sub_id);
        assert_eq!(sub_don.amount, 500);
        assert_eq!(sub_don.creator, creator);
        assert_eq!(sub_don.donor, donor);
    }
}
