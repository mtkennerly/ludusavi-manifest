use std::collections::HashMap;

use crate::{
    manifest::{placeholder, Manifest, ManifestOverride},
    schema,
    steam::SteamCache,
    wiki::{WikiCache, WikiMetaCache},
    Error,
};

fn styles() -> clap::builder::styling::Styles {
    use clap::builder::styling::{AnsiColor, Effects, Styles};

    Styles::styled()
        .header(AnsiColor::Yellow.on_default() | Effects::BOLD)
        .usage(AnsiColor::Yellow.on_default() | Effects::BOLD)
        .literal(AnsiColor::Green.on_default() | Effects::BOLD)
        .placeholder(AnsiColor::Green.on_default())
}

fn parse_games(games: Vec<String>) -> Vec<String> {
    if !games.is_empty() {
        games
    } else {
        use std::io::IsTerminal;

        let stdin = std::io::stdin();
        if stdin.is_terminal() {
            vec![]
        } else {
            stdin.lines().map_while(Result::ok).collect()
        }
    }
}

#[derive(clap::Parser, Clone, Debug, PartialEq, Eq)]
#[clap(name = "ludusavi-manifest", version, max_term_width = 100, next_line_help = true, styles = styles())]
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

        /// Only refresh this many entries.
        #[clap(long)]
        limit: Option<usize>,

        /// Do a partial update based on the wiki's recent changes.
        #[clap(long)]
        recent_changes: bool,

        /// Do a partial update based on the wiki's game pages that are not yet cached.
        #[clap(long)]
        missing_pages: bool,

        /// Refresh wiki entries starting from this article title.
        /// This will enable full mode for wiki entries.
        #[clap(long)]
        wiki_from: Option<String>,

        /// Refresh Steam entries starting from this app ID.
        /// This will enable full mode for Steam entries.
        #[clap(long)]
        steam_from: Option<u32>,
    },
    /// Fetch a named subset of games.
    Solo {
        /// Only use local data.
        #[clap(long)]
        local: bool,

        /// Games to update, by wiki article title.
        #[clap()]
        games: Vec<String>,
    },
    /// Validate the manifest against its schema.
    Schema,
    /// Display some stats about the manifest.
    Stats,
    /// Find duplicate manifest entries.
    Duplicates,
    /// List games with irregular paths.
    Irregular,
    /// Try parsing a file containing wikitext.
    /// If there are parsing errors, print them and exit with 1;
    /// otherwise, print nothing and exit with 0.
    Wikitext {
        /// Path to file containing wikitext.
        #[clap(default_value_t = format!("{}/tmp/wiki.txt", crate::REPO))]
        path: String,
    },
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
            limit,
            recent_changes,
            missing_pages,
            wiki_from,
            steam_from,
        } => {
            let outdated_only = !full && wiki_from.is_none();
            if recent_changes {
                wiki_cache.flag_recent_changes(wiki_meta_cache).await?;
            }
            if missing_pages {
                wiki_cache.add_new_articles().await?;
            }
            wiki_cache.refresh(outdated_only, None, limit, wiki_from).await?;

            let outdated_only = steam_from.is_none();
            steam_cache.transition_states_from(wiki_cache);
            steam_cache.refresh(outdated_only, None, limit, steam_from)?;

            manifest.refresh(manifest_override, wiki_cache, steam_cache)?;
            schema::validate_manifest(manifest)?;

            if recent_changes {
                print_stats(manifest, wiki_cache);
            }
        }
        Subcommand::Solo { local, games } => {
            let games = parse_games(games);
            let outdated_only = false;

            if !local {
                wiki_cache
                    .refresh(outdated_only, Some(games.clone()), None, None)
                    .await?;

                let steam_ids: Vec<_> = games
                    .iter()
                    .filter_map(|x| wiki_cache.0.get(x).and_then(|x| x.steam))
                    .collect();

                steam_cache.transition_states_from(wiki_cache);
                steam_cache.refresh(outdated_only, Some(steam_ids), None, None)?;
            }

            manifest.refresh(manifest_override, wiki_cache, steam_cache)?;
            schema::validate_manifest(manifest)?;
        }
        Subcommand::Schema => {
            schema::validate_manifest(manifest)?;
        }
        Subcommand::Stats => {
            print_stats(manifest, wiki_cache);
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
        Subcommand::Irregular => {
            for (game, info) in &wiki_cache.0 {
                if info.any_irregular_paths(game.to_string()) {
                    println!("{}", game);
                }
            }
        }
        Subcommand::Wikitext { path } => {
            let Ok(content) = std::fs::read_to_string(&path) else {
                eprintln!("Unable to read file: {path}");
                std::process::exit(2);
            };

            let mut malformed = false;
            wikitext_parser::parse_wikitext(&content, "Test".to_string(), |e| {
                malformed = true;
                dbg!(e);
            });

            if malformed {
                std::process::exit(1);
            } else {
                std::process::exit(0);
            }
        }
    }

    Ok(())
}

fn print_stats(manifest: &Manifest, wiki_cache: &WikiCache) {
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
