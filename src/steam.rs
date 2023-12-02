use std::{collections::BTreeMap, process::Command};

use crate::{resource::ResourceFile, wiki::WikiCache, Error, State, REPO};

const SAVE_INTERVAL: u32 = 100;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SteamCache(pub BTreeMap<u32, SteamCacheEntry>);

impl ResourceFile for SteamCache {
    const FILE_NAME: &'static str = "data/steam-game-cache.yaml";
}

impl SteamCache {
    pub fn refresh(&mut self, outdated_only: bool, app_ids: Option<Vec<u32>>) -> Result<(), Error> {
        let mut i = 0;
        let app_ids: Vec<_> = app_ids.unwrap_or_else(|| {
            self.0
                .iter()
                .filter(|(_, v)| !outdated_only || v.state == State::Outdated)
                .map(|(k, _)| *k)
                .collect()
        });

        for app_id in app_ids {
            let latest = SteamCacheEntry::fetch_from_id(app_id)?;
            self.0.insert(
                app_id,
                latest.unwrap_or_else(|| SteamCacheEntry {
                    state: State::Handled,
                    ..Default::default()
                }),
            );

            i += 1;
            if i % SAVE_INTERVAL == 0 {
                self.save();
                println!("\n:: saved\n");
            }
        }

        Ok(())
    }

    pub fn transition_states_from(&mut self, wiki_cache: &mut WikiCache) {
        for wiki in wiki_cache.0.values_mut() {
            if wiki.state == State::Updated {
                if let Some(id) = wiki.steam {
                    self.0
                        .entry(id)
                        .and_modify(|x| {
                            x.state = State::Outdated;
                        })
                        .or_insert(SteamCacheEntry {
                            state: State::Outdated,
                            ..Default::default()
                        });
                }
                wiki.state = State::Handled;
            }
        }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SteamCacheEntry {
    #[serde(skip_serializing_if = "State::is_handled")]
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub launch: Vec<Launch>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub name_localized: BTreeMap<String, String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Launch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    #[serde(skip_serializing_if = "LaunchConfig::is_empty")]
    pub config: LaunchConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workingdir: Option<String>,
}

impl Launch {
    pub fn is_empty(&self) -> bool {
        self.arguments.is_none()
            && self.config.is_empty()
            && self.description.is_none()
            && self.executable.is_none()
            && self.r#type.is_none()
            && self.workingdir.is_none()
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub betakey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osarch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oslist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownsdlc: Option<String>,
}

impl LaunchConfig {
    pub fn is_empty(&self) -> bool {
        self.betakey.is_none() && self.osarch.is_none() && self.oslist.is_none() && self.ownsdlc.is_none()
    }
}

mod product_info {
    use super::*;

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    pub struct Response {
        pub apps: BTreeMap<String, App>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct App {
        pub common: AppCommon,
        pub config: AppConfig,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppCommon {
        pub name_localized: BTreeMap<String, String>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppConfig {
        pub installdir: Option<String>,
        pub launch: BTreeMap<String, AppLaunch>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppLaunch {
        pub executable: Option<String>,
        pub arguments: Option<String>,
        pub workingdir: Option<String>,
        pub r#type: Option<String>,
        pub config: AppLaunchConfig,
        pub description: Option<String>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppLaunchConfig {
        pub betakey: Option<String>,
        pub osarch: Option<String>,
        pub oslist: Option<String>,
        pub ownsdlc: Option<String>,
    }
}

impl SteamCacheEntry {
    pub fn fetch_from_id(app_id: u32) -> Result<Option<Self>, Error> {
        println!("Steam: {}", app_id);

        let mut cmd = Command::new("python");
        cmd.arg(format!("{}/scripts/get-steam-app-info.py", REPO));
        cmd.arg(app_id.to_string());
        let output = cmd.output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("Steam product info failure: {}", &stderr);
            return Err(Error::SteamProductInfo);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);

        let response = serde_json::from_str::<product_info::Response>(&stdout).map_err(|_| Error::SteamProductInfo)?;
        let Some(app) = response.apps.get(&app_id.to_string()).cloned() else {
            eprintln!("No results for Steam ID: {}", app_id);
            return Ok(None);
        };

        let launch: Vec<_> = app
            .config
            .launch
            .into_values()
            .map(|x| Launch {
                executable: x.executable,
                arguments: x.arguments,
                workingdir: x.workingdir,
                r#type: x.r#type,
                description: x.description,
                config: LaunchConfig {
                    betakey: x.config.betakey,
                    osarch: x.config.osarch,
                    oslist: x.config.oslist,
                    ownsdlc: x.config.ownsdlc,
                },
            })
            .filter(|x| !x.is_empty())
            .collect();

        Ok(Some(Self {
            state: State::Handled,
            install_dir: app.config.installdir,
            name_localized: app.common.name_localized,
            launch,
        }))
    }
}
