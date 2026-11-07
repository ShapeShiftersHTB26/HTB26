//! LiteSVM tests: mint / merge / resolve / redeem / void + vault invariant.
//! Run with `anchor build && cargo test -p prediction-market` (the test loads target/deploy/*.so).

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{
            get_associated_token_address,
            spl_associated_token_account::instruction::create_associated_token_account_idempotent,
        },
        token::spl_token,
    },
    litesvm::LiteSVM,
    prediction_market::{constants::*, state::Outcome},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const ONE: u64 = 1_000_000; // 1 token with 6 decimals

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    usdc: Pubkey,
}

struct Mkt {
    market: Pubkey,
    yes: Pubkey,
    no: Pubkey,
    vault: Pubkey,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
    let res = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    res
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    use anchor_lang::solana_program::program_pack::Pack;
    let acc = svm.get_account(account).unwrap();
    spl_token::state::Account::unpack(&acc.data).unwrap().amount
}

fn mint_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    use anchor_lang::solana_program::program_pack::Pack;
    let acc = svm.get_account(mint).unwrap();
    spl_token::state::Mint::unpack(&acc.data).unwrap().supply
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &prediction_market::id()).0
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/prediction_market.so"));
    svm.add_program(prediction_market::id(), bytes).unwrap();
    set_time(&mut svm, 1_800_000_000);

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();

    // mUSDC mint, authority = admin
    let usdc = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    send(
        &mut svm,
        &[
            system_instruction::create_account(&admin.pubkey(), &usdc.pubkey(), rent, spl_token::state::Mint::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &usdc.pubkey(), &admin.pubkey(), None, 6).unwrap(),
        ],
        &admin,
        &[&usdc],
    )
    .unwrap();

    let ix = Instruction::new_with_bytes(
        prediction_market::id(),
        &prediction_market::instruction::InitializeConfig {}.data(),
        prediction_market::accounts::InitializeConfig {
            admin: admin.pubkey(),
            config: config_pda(),
            collateral_mint: usdc.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &admin, &[]).unwrap();

    Env { svm, admin, usdc: usdc.pubkey() }
}

use anchor_lang::solana_program::program_pack::Pack;

fn create_market(env: &mut Env, id: u64, resolution_time: i64) -> Result<Mkt, String> {
    create_market_as(env, id, resolution_time, None)
}

fn create_market_as(env: &mut Env, id: u64, resolution_time: i64, signer: Option<&Keypair>) -> Result<Mkt, String> {
    let pid = prediction_market::id();
    let market = Pubkey::find_program_address(&[MARKET_SEED, &id.to_le_bytes()], &pid).0;
    let yes = Pubkey::find_program_address(&[YES_MINT_SEED, market.as_ref()], &pid).0;
    let no = Pubkey::find_program_address(&[NO_MINT_SEED, market.as_ref()], &pid).0;
    let vault = Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], &pid).0;
    let signer = signer.unwrap_or(&env.admin);
    let ix = Instruction::new_with_bytes(
        pid,
        &prediction_market::instruction::InitializeMarket { id, resolution_time }.data(),
        prediction_market::accounts::InitializeMarket {
            admin: signer.pubkey(),
            config: config_pda(),
            collateral_mint: env.usdc,
            market,
            yes_mint: yes,
            no_mint: no,
            vault,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let signer_kp = signer.insecure_clone();
    send(&mut env.svm, &[ix], &signer_kp, &[])?;
    Ok(Mkt { market, yes, no, vault })
}

/// New funded user with ATAs for mUSDC/YES/NO and `usdc` mUSDC.
fn new_user(env: &mut Env, m: &Mkt, usdc: u64) -> Keypair {
    let user = Keypair::new();
    env.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
    let mut ixs = vec![];
    for mint in [env.usdc, m.yes, m.no] {
        ixs.push(create_associated_token_account_idempotent(&user.pubkey(), &user.pubkey(), &mint, &spl_token::ID));
    }
    send(&mut env.svm, &ixs, &user, &[]).unwrap();
    let ata = get_associated_token_address(&user.pubkey(), &env.usdc);
    let admin = env.admin.insecure_clone();
    send(
        &mut env.svm,
        &[spl_token::instruction::mint_to(&spl_token::ID, &env.usdc, &ata, &admin.pubkey(), &[], usdc).unwrap()],
        &admin,
        &[],
    )
    .unwrap();
    user
}

fn set_accounts(env: &Env, m: &Mkt, user: &Pubkey) -> Vec<anchor_lang::prelude::AccountMeta> {
    prediction_market::accounts::CompleteSet {
        user: *user,
        market: m.market,
        yes_mint: m.yes,
        no_mint: m.no,
        vault: m.vault,
        user_collateral: get_associated_token_address(user, &env.usdc),
        user_yes: get_associated_token_address(user, &m.yes),
        user_no: get_associated_token_address(user, &m.no),
        token_program: spl_token::ID,
    }
    .to_account_metas(None)
}

fn mint_set(env: &mut Env, m: &Mkt, user: &Keypair, amount: u64) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        prediction_market::id(),
        &prediction_market::instruction::MintCompleteSet { amount }.data(),
        set_accounts(env, m, &user.pubkey()),
    );
    send(&mut env.svm, &[ix], user, &[])
}

fn merge_set(env: &mut Env, m: &Mkt, user: &Keypair, amount: u64) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        prediction_market::id(),
        &prediction_market::instruction::MergeCompleteSet { amount }.data(),
        set_accounts(env, m, &user.pubkey()),
    );
    send(&mut env.svm, &[ix], user, &[])
}

fn redeem(env: &mut Env, m: &Mkt, user: &Keypair, yes_amount: u64, no_amount: u64) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        prediction_market::id(),
        &prediction_market::instruction::Redeem { yes_amount, no_amount }.data(),
        set_accounts(env, m, &user.pubkey()),
    );
    send(&mut env.svm, &[ix], user, &[])
}

fn resolve(env: &mut Env, m: &Mkt, signer: &Keypair, outcome: Outcome) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        prediction_market::id(),
        &prediction_market::instruction::ResolveMarket { outcome }.data(),
        prediction_market::accounts::ResolveMarket {
            admin: signer.pubkey(),
            config: config_pda(),
            market: m.market,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &[ix], signer, &[])
}

fn assert_invariant(env: &Env, m: &Mkt) {
    let vault = token_balance(&env.svm, &m.vault);
    assert_eq!(vault, mint_supply(&env.svm, &m.yes), "vault != YES supply");
    assert_eq!(vault, mint_supply(&env.svm, &m.no), "vault != NO supply");
}

fn bal(env: &Env, owner: &Pubkey, mint: &Pubkey) -> u64 {
    token_balance(&env.svm, &get_associated_token_address(owner, mint))
}

#[test]
fn mint_and_merge_keep_invariant() {
    let mut env = setup();
    let t = now(&env.svm) + 3600;
    let m = create_market(&mut env, 1, t).unwrap();
    let alice = new_user(&mut env, &m, 100 * ONE);

    mint_set(&mut env, &m, &alice, 10 * ONE).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &m.yes), 10 * ONE);
    assert_eq!(bal(&env, &alice.pubkey(), &m.no), 10 * ONE);
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 90 * ONE);
    assert_invariant(&env, &m);

    merge_set(&mut env, &m, &alice, 4 * ONE).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &m.yes), 6 * ONE);
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 94 * ONE);
    assert_invariant(&env, &m);

    // Can't merge more than held, can't mint zero.
    assert!(merge_set(&mut env, &m, &alice, 7 * ONE).is_err());
    assert!(mint_set(&mut env, &m, &alice, 0).is_err());
    assert_invariant(&env, &m);
}

#[test]
fn only_admin_creates_and_resolves() {
    let mut env = setup();
    let t = now(&env.svm) + 3600;
    let past = now(&env.svm) - 1;
    let mallory = Keypair::new();
    env.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    assert!(create_market_as(&mut env, 7, t, Some(&mallory)).is_err());
    // resolution time must be in the future
    assert!(create_market(&mut env, 8, past).is_err());

    let m = create_market(&mut env, 9, t).unwrap();
    set_time(&mut env.svm, t);
    assert!(resolve(&mut env, &m, &mallory, Outcome::Yes).is_err());
}

#[test]
fn resolve_yes_and_redeem() {
    let mut env = setup();
    let t = now(&env.svm) + 3600;
    let m = create_market(&mut env, 2, t).unwrap();
    let alice = new_user(&mut env, &m, 100 * ONE);
    let bob = new_user(&mut env, &m, 100 * ONE);
    mint_set(&mut env, &m, &alice, 10 * ONE).unwrap();
    mint_set(&mut env, &m, &bob, 5 * ONE).unwrap();

    let admin = env.admin.insecure_clone();
    // too early / unresolved redeem
    assert!(resolve(&mut env, &m, &admin, Outcome::Yes).is_err());
    assert!(redeem(&mut env, &m, &alice, ONE, 0).is_err());

    set_time(&mut env.svm, t);
    assert!(resolve(&mut env, &m, &admin, Outcome::Unresolved).is_err());
    resolve(&mut env, &m, &admin, Outcome::Yes).unwrap();
    assert!(resolve(&mut env, &m, &admin, Outcome::No).is_err(), "double resolve");
    assert!(mint_set(&mut env, &m, &alice, ONE).is_err(), "mint after resolve");

    // Alice redeems 10 YES + 10 NO → 10 mUSDC (NO worthless)
    redeem(&mut env, &m, &alice, 10 * ONE, 10 * ONE).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 100 * ONE);
    assert_eq!(bal(&env, &alice.pubkey(), &m.yes), 0);
    assert_eq!(bal(&env, &alice.pubkey(), &m.no), 0);

    // Bob redeems only YES
    redeem(&mut env, &m, &bob, 5 * ONE, 0).unwrap();
    assert_eq!(bal(&env, &bob.pubkey(), &env.usdc), 100 * ONE);
    // Bob's NO is worthless and the vault is exactly empty.
    assert_eq!(token_balance(&env.svm, &m.vault), 0);

    // merge still allowed after resolution (no-op here since Bob has no YES)
    assert!(merge_set(&mut env, &m, &bob, ONE).is_err());
}

#[test]
fn resolve_no_pays_no_holders() {
    let mut env = setup();
    let t = now(&env.svm) + 60;
    let m = create_market(&mut env, 3, t).unwrap();
    let alice = new_user(&mut env, &m, 10 * ONE);
    mint_set(&mut env, &m, &alice, 10 * ONE).unwrap();
    set_time(&mut env.svm, t + 1);
    let admin = env.admin.insecure_clone();
    resolve(&mut env, &m, &admin, Outcome::No).unwrap();
    redeem(&mut env, &m, &alice, 3 * ONE, 4 * ONE).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 4 * ONE);
}

#[test]
fn void_pays_half_per_token() {
    let mut env = setup();
    let t = now(&env.svm) + 60;
    let m = create_market(&mut env, 4, t).unwrap();
    let alice = new_user(&mut env, &m, 10 * ONE);
    mint_set(&mut env, &m, &alice, 10 * ONE).unwrap();
    set_time(&mut env.svm, t);
    let admin = env.admin.insecure_clone();
    resolve(&mut env, &m, &admin, Outcome::Void).unwrap();

    // Only YES: 4 YES → 2 mUSDC
    redeem(&mut env, &m, &alice, 4 * ONE, 0).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 2 * ONE);
    // Rest: 6 YES + 10 NO → 8 mUSDC; total 10 = everything deposited
    redeem(&mut env, &m, &alice, 6 * ONE, 10 * ONE).unwrap();
    assert_eq!(bal(&env, &alice.pubkey(), &env.usdc), 10 * ONE);
    assert_eq!(token_balance(&env.svm, &m.vault), 0);
}
