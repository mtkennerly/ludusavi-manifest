mod cli;
mod manifest;
mod missing;
mod path;
mod registry;
mod resource;
mod schema;
mod steam;
mod wiki;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use once_cell::sync::Lazy;

use crate::{
    manifest::{Manifest, ManifestOverride},
    resource::ResourceFile,
    steam::SteamCache,
    wiki::{WikiCache, WikiMetaCache},
};

pub const REPO: &str = env!("CARGO_MANIFEST_DIR");
static CANCEL: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

pub fn should_cancel() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// This entry needs to be re-fetched from the data source.
    Outdated,
    /// This entry has been re-fetched, but is awaiting recognition by another step.
    Updated,
    /// This entry has been fully processed.
    #[default]
    Handled,
}

impl State {
    pub fn is_handled(&self) -> bool {
        *self == Self::Handled
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub enum Regularity {
    /// Normal and may be included in the data set
    #[default]
    Regular,
    /// Somewhat irregular, but still usable for the data set
    Semiregular,
    /// Fully irregular and should be excluded from the data set
    Irregular,
}

impl Regularity {
    pub fn worst(&self, other: Self) -> Self {
        if other > *self {
            other
        } else {
            *self
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Wiki client: {0}")]
    WikiClient(#[from] mediawiki::media_wiki_error::MediaWikiError),
    #[error("Wiki data missing or malformed: {0}")]
    WikiData(&'static str),
    #[error("Unable to find page by title or ID")]
    PageMissing,
    #[error("Could not find product info")]
    SteamProductInfo,
    #[error("Could not decode product info: {0:?}")]
    SteamProductInfoDecoding(serde_json::Error),
    #[error("Schema validation failed for manifest")]
    ManifestSchema,
    #[error("Subprocess: {0}")]
    Subprocess(#[from] std::io::Error),
}

impl Error {
    pub fn should_discard_work(&self) -> bool {
        match self {
            Error::WikiClient(_)
            | Error::WikiData(_)
            | Error::PageMissing
            | Error::SteamProductInfo
            | Error::SteamProductInfoDecoding(_)
            | Error::Subprocess(_) => false,
            Error::ManifestSchema => true,
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = cli::parse();

    signal_hook::flag::register(signal_hook::consts::SIGINT, (*CANCEL).clone()).unwrap();

    let mut wiki_cache = WikiCache::load().unwrap();
    let mut wiki_meta_cache = WikiMetaCache::load().unwrap();
    let mut steam_cache = SteamCache::load().unwrap();
    let mut manifest = Manifest::load().unwrap();
    let mut manifest_override = ManifestOverride::load().unwrap();

    let mut success = true;
    let mut discard = false;
    if let Err(e) = cli::run(
        cli.sub,
        &mut manifest,
        &mut manifest_override,
        &mut wiki_cache,
        &mut wiki_meta_cache,
        &mut steam_cache,
    )
    .await
    {
        eprintln!("{e}");
        success = false;
        discard = e.should_discard_work();
    }

    if !discard {
        if success {
            wiki_meta_cache.save();
        }
        wiki_cache.save();
        steam_cache.save();
        manifest.save();
        missing::save_missing_games(&wiki_cache, &manifest, &manifest_override);
        wiki::save_malformed_list(&wiki_cache);
    }

    if !success {
        std::process::exit(1);
    }
}
