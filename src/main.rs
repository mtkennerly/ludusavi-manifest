mod cli;
mod manifest;
mod missing;
mod resource;
mod schema;
mod steam;
mod wiki;

use crate::{
    manifest::{Manifest, ManifestOverride},
    resource::ResourceFile,
    steam::SteamCache,
    wiki::{WikiCache, WikiMetaCache},
};

pub const REPO: &str = env!("CARGO_MANIFEST_DIR");

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
            | Error::Subprocess(_) => false,
            Error::ManifestSchema => true,
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = cli::parse();

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
    }

    if !success {
        std::process::exit(1);
    }
}
