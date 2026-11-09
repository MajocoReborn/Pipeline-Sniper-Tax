//! Which mints a pool accepts (docs/PLAN.md section 6).
//!
//! Extensions are checked on an allowlist, so an extension this program doesn't know
//! (added to Token-2022 later) is refused. A mint's extensions are fixed when it is
//! created, so they are checked when the pool is created and again at launch. Its freeze
//! and mint authorities can still be revoked between the two, so they are checked at
//! launch only.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as MintState,
};
use anchor_spl::token_interface::Mint;

use crate::errors::SniperError;

/// Extensions that can't take tokens from the pool or its traders, or stop trading.
fn is_allowed(extension: ExtensionType) -> bool {
    matches!(
        extension,
        ExtensionType::Uninitialized
            // Vault deltas are measured, so a transfer fee is priced correctly.
            | ExtensionType::TransferFeeConfig
            // A mint can only be closed at zero supply.
            | ExtensionType::MintCloseAuthority
            // Change only the UI amount; the maths uses raw amounts.
            | ExtensionType::InterestBearingConfig
            | ExtensionType::ScaledUiAmount
            // Hook accounts are forwarded to every transfer.
            | ExtensionType::TransferHook
            // Metadata and groups are descriptive.
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
    )
}

/// Refuses a mint with an extension outside the allowlist, such as a permanent delegate
/// (could drain the vaults), non-transferability, pausing, a default frozen state or
/// confidential transfers. SPL Token mints have no extensions.
pub fn check_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner == anchor_spl::token::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(SniperError::ForbiddenMintExtension))?;
    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(SniperError::ForbiddenMintExtension))?;
    require!(
        extensions.into_iter().all(is_allowed),
        SniperError::ForbiddenMintExtension
    );
    Ok(())
}

/// A launch token must have no freeze authority (which could freeze the vault or buyers)
/// and no mint authority (which could mint and dump without limit).
pub fn check_launch_authorities(mint: &InterfaceAccount<Mint>) -> Result<()> {
    require!(
        mint.freeze_authority.is_none(),
        SniperError::FreezeAuthorityPresent
    );
    require!(
        mint.mint_authority.is_none(),
        SniperError::MintAuthorityPresent
    );
    Ok(())
}
