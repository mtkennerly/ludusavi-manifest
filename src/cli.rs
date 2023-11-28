use std::collections::HashMap;

use crate::{
    manifest::{placeholder, Manifest, ManifestOverride},
    schema,
    steam::SteamCache,
    wiki::{WikiCache, WikiMetaCache},
    Error,
};

#[derive(clap::Parser, Clone, Debug, PartialEq, Eq)]
#[clap(name = "ludusavi", version, term_width = 79)]
pub struct Cli {
    #[clap(subcommand)]
    pub sub: Subcommand,
}

#[derive(clap::Subcommand, Clone, Debug, PartialEq, Eq)]
pub enum Subcommand {
    /// Fetch bulk updates from the data sources.
    /// By default, this only updates entries that are marked as outdated.
    Bulk {
        /// Do a full sync.
        #[clap(long)]
        full: bool,

        /// Do a partial update based on the wiki's recent changes.
        #[clap(long)]
        recent_changes: bool,

        /// Do a partial update based on the wiki's game pages that are not yet cached.
        #[clap(long)]
        missing_pages: bool,
    },
    /// Fetch a named subset of games.
    Solo {
        #[clap(long)]
        local: bool,

        #[clap()]
        games: Vec<String>,
    },
    /// Validate the manifest against its schema.
    Schema,
    /// Display some stats about the manifest.
    Stats,
    /// Find duplicate manifest entries.
    Duplicates,
}

pub fn parse() -> Cli {
    use clap::Parser;
    Cli::parse()
}

pub async fn run(
    sub: Subcommand,
    manifest: &mut Manifest,
    manifest_override: &mut ManifestOverride,
    wiki_cache: &mut WikiCache,
    wiki_meta_cache: &mut WikiMetaCache,
    steam_cache: &mut SteamCache,
) -> Result<(), Error> {
    match sub {
        Subcommand::Bulk {
            full,
            recent_changes,
            missing_pages,
        } => {
            let outdated_only = !full;

            if recent_changes {
                wiki_cache.flag_recent_changes(wiki_meta_cache).await?;
            }

            if missing_pages {
                wiki_cache.add_new_games().await?;
            }

            wiki_cache.refresh(outdated_only, None).await?;

            steam_cache.transition_states_from(wiki_cache);
            steam_cache.refresh(outdated_only, None)?;

            manifest.refresh(manifest_override, wiki_cache, steam_cache, None)?;
            schema::validate_manifest(manifest)?;
        }
        Subcommand::Solo { local, games } => {
            let outdated_only = false;

            if !local {
                wiki_cache.refresh(outdated_only, Some(games.clone())).await?;

                let steam_ids: Vec<_> = games
                    .iter()
                    .filter_map(|x| wiki_cache.0.get(x).and_then(|x| x.steam))
                    .collect();

                steam_cache.transition_states_from(wiki_cache);
                steam_cache.refresh(outdated_only, Some(steam_ids))?;
            }

            manifest.refresh(manifest_override, wiki_cache, steam_cache, Some(games))?;
            schema::validate_manifest(manifest)?;
        }
        Subcommand::Schema => {
            schema::validate_manifest(manifest)?;
        }
        Subcommand::Stats => {
            let games = manifest.0.keys().count();
            let files_or_registry = manifest
                .0
                .values()
                .filter(|x| !x.files.is_empty() || !x.registry.is_empty())
                .count();
            let no_files_or_registry = manifest
                .0
                .values()
                .filter(|x| x.files.is_empty() && x.registry.is_empty())
                .count();
            let in_wiki_cache = wiki_cache.0.keys().count();

            println!("Total games in manifest: {}", games);
            println!("Total games in manifest with files or registry: {}", files_or_registry);
            println!(
                "Total games in manifest without files and registry: {}",
                no_files_or_registry
            );
            println!("Total games in wiki cache: {}", in_wiki_cache);
        }
        Subcommand::Duplicates => {
            struct Duplicate {
                name: String,
                page_id: u64,
            }
            let mut data = HashMap::<String, Vec<Duplicate>>::new();

            'games: for (name, info) in &manifest.0 {
                for file in info.files.keys() {
                    if file.contains(placeholder::GAME) || file.contains(placeholder::BASE) {
                        continue 'games;
                    }
                }
                let key = serde_json::to_string(info).unwrap();
                data.entry(key).or_default().push(Duplicate {
                    name: name.clone(),
                    page_id: wiki_cache.0.get(name).map(|x| x.page_id).unwrap_or(0),
                });
            }

            for duplicates in data.values() {
                if duplicates.len() > 1 {
                    let lines: Vec<_> = duplicates
                        .iter()
                        .map(|x| format!("[{}] {}", x.page_id, x.name))
                        .collect();
                    println!("\nSame manifest entry:\n  - {}", lines.join("\n  - "));
                }
            }
        }
    }

    Ok(())
}
