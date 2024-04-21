use std::{
    collections::{BTreeMap, HashSet},
    process::Command,
};

use crate::{
    manifest::{placeholder, Os},
    resource::ResourceFile,
    should_cancel,
    wiki::WikiCache,
    Error, State, REPO,
};

const SAVE_INTERVAL: u32 = 250;
const CHUNK_SIZE: usize = 25;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SteamCache(pub BTreeMap<u32, SteamCacheEntry>);

impl ResourceFile for SteamCache {
    const FILE_NAME: &'static str = "data/steam-game-cache.yaml";
}

impl SteamCache {
    pub fn refresh(
        &mut self,
        outdated_only: bool,
        app_ids: Option<Vec<u32>>,
        limit: Option<usize>,
        from: Option<u32>,
    ) -> Result<(), Error> {
        let mut i = 0;
        let app_ids: Vec<_> = app_ids.unwrap_or_else(|| {
            self.0
                .iter()
                .filter(|(_, v)| !outdated_only || v.state == State::Outdated)
                .skip_while(|(k, _)| from.is_some_and(|from| &from != *k))
                .take(limit.unwrap_or(usize::MAX))
                .map(|(k, _)| *k)
                .collect()
        });

        for app_ids in app_ids.chunks(CHUNK_SIZE) {
            if should_cancel() {
                break;
            }

            let info = ProductInfo::fetch(app_ids)?;
            for app_id in app_ids {
                let latest = SteamCacheEntry::parse_app(*app_id, &info)?;
                self.0.insert(
                    *app_id,
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub irregular: bool,
    #[serde(skip_serializing_if = "Cloud::is_empty")]
    pub cloud: Cloud,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub launch: Vec<Launch>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub name_localized: BTreeMap<String, String>,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Cloud {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub saves: Vec<CloudSave>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<CloudOverride>,
}

impl Cloud {
    pub fn is_empty(&self) -> bool {
        self.saves.is_empty() && self.overrides.is_empty()
    }
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudSave {
    pub path: String,
    pub pattern: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub recursive: bool,
    pub root: String,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_compare: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path_transforms: Vec<CloudTransform>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub recursive: bool,
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_instead: Option<String>,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudTransform {
    pub find: String,
    pub replace: String,
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

struct ProductInfo {
    response: product_info::Response,
    irregular: HashSet<u32>,
}

impl ProductInfo {
    fn fetch(app_ids: &[u32]) -> Result<ProductInfo, Error> {
        println!("Steam batch: {:?} to {:?}", app_ids.first(), app_ids.last());

        let mut cmd = Command::new("python");
        cmd.arg(format!("{}/scripts/get-steam-app-info.py", REPO));
        for app_id in app_ids {
            cmd.arg(app_id.to_string());
        }

        let output = cmd.output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("Steam product info failure: {}", &stderr);
            return Err(Error::SteamProductInfo);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);

        let mut info = ProductInfo {
            response: serde_json::from_str::<product_info::Response>(&stdout)
                .map_err(Error::SteamProductInfoDecoding)?,
            irregular: Default::default(),
        };

        // Debugging:
        let raw = serde_json::from_str::<serde_json::Value>(&stdout).map_err(Error::SteamProductInfoDecoding)?;
        for app_id in app_ids {
            if let Some(ufs) = raw["apps"][app_id.to_string()]["ufs"]["save_files"].as_object() {
                let keys: Vec<_> = ufs.keys().collect();
                for key in keys {
                    let key = key.to_string();
                    if !["path", "pattern", "platforms", "recursive", "root"].contains(&key.as_str()) {
                        info.irregular.insert(*app_id);
                        println!("[Steam] Unknown save key: {}", key);
                    }
                }
            }
            if let Some(ufs) = raw["apps"][app_id.to_string()]["ufs"]["root_overrides"].as_object() {
                let keys: Vec<_> = ufs.keys().collect();
                for key in keys {
                    let key = key.to_string();
                    if ![
                        "add_path",
                        "os",
                        "os_compare",
                        "path_transforms",
                        "recursive",
                        "root",
                        "use_instead",
                    ]
                    .contains(&key.as_str())
                    {
                        info.irregular.insert(*app_id);
                        println!("[Steam] Unknown override key: {}", key);
                    }
                }
            }
        }

        Ok(info)
    }
}

mod product_info {
    use super::*;

    fn parse_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        let s: String = serde::de::Deserialize::deserialize(deserializer)?;
        Ok(s == "1")
    }

    fn parse_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::de::DeserializeOwned,
    {
        use serde::de::Deserialize;

        let mut out = vec![];
        let raw = match BTreeMap::<String, serde_json::Value>::deserialize(deserializer) {
            Ok(x) => x,
            Err(e) => {
                println!("  parse_vec: total failure - {e:?}");
                return Err(e);
            }
        };

        for (key, value) in raw {
            if key.parse::<u32>().is_err() {
                println!("  parse_vec: unexpected key '{}'", key);
                continue;
            }

            match serde_json::from_value::<T>(value) {
                Ok(value) => out.push(value),
                Err(e) => {
                    println!("  parse_vec: type failure - {e:?}");
                    return Err(serde::de::Error::custom(format!("parse_vec: type failure - {e:?}")));
                }
            }
        }

        Ok(out)
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    pub struct Response {
        pub apps: BTreeMap<String, App>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct App {
        pub common: AppCommon,
        pub config: AppConfig,
        pub ufs: AppUfs,
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

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppUfs {
        #[serde(rename = "savefiles", deserialize_with = "parse_vec")]
        pub save_files: Vec<AppUfsSaveFile>,
        #[serde(rename = "rootoverrides")]
        pub root_overrides: BTreeMap<String, AppUfsRootOverride>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppUfsSaveFile {
        pub path: String,
        pub pattern: String,
        pub platforms: BTreeMap<String, String>,
        #[serde(deserialize_with = "parse_bool")]
        pub recursive: bool,
        pub root: String,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppUfsRootOverride {
        #[serde(rename = "addpath")]
        pub add_path: Option<String>,
        pub os: Option<String>,
        #[serde(rename = "oscompare")]
        pub os_compare: Option<String>,
        #[serde(rename = "pathtransforms")]
        pub path_transforms: Option<BTreeMap<String, AppUfsPathTransform>>,
        pub platforms: BTreeMap<String, String>,
        #[serde(deserialize_with = "parse_bool")]
        pub recursive: bool,
        pub root: String,
        #[serde(rename = "useinstead")]
        pub use_instead: Option<String>,
    }

    #[derive(Debug, Default, Clone, serde::Deserialize)]
    #[serde(default)]
    pub struct AppUfsPathTransform {
        pub find: String,
        pub replace: String,
    }
}

impl SteamCacheEntry {
    fn parse_app(app_id: u32, info: &ProductInfo) -> Result<Option<Self>, Error> {
        println!("Steam: {}", app_id);

        let Some(app) = info.response.apps.get(&app_id.to_string()).cloned() else {
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

        let cloud = Cloud {
            saves: app
                .ufs
                .save_files
                .into_iter()
                .map(|x| CloudSave {
                    path: x.path,
                    pattern: x.pattern,
                    platforms: x.platforms.into_values().collect(),
                    recursive: x.recursive,
                    root: x.root,
                })
                .collect(),
            overrides: app
                .ufs
                .root_overrides
                .into_values()
                .map(|x| CloudOverride {
                    add_path: x.add_path,
                    os: x.os,
                    os_compare: x.os_compare,
                    path_transforms: x
                        .path_transforms
                        .map(|x| {
                            x.into_values()
                                .map(|x| CloudTransform {
                                    find: x.find,
                                    replace: x.replace,
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    recursive: x.recursive,
                    root: x.root,
                    use_instead: x.use_instead,
                })
                .collect(),
        };

        Ok(Some(Self {
            state: State::Handled,
            irregular: info.irregular.contains(&app_id),
            cloud,
            install_dir: app.config.installdir,
            name_localized: app.common.name_localized,
            launch,
        }))
    }
}

pub fn parse_root(value: &str) -> Option<&'static str> {
    match value.to_lowercase().as_ref() {
        "gameinstall" => Some(placeholder::BASE),
        "linuxhome" => Some(placeholder::HOME),
        "linuxxdgdatahome" => Some(placeholder::XDG_DATA),
        "macappsupport" => Some("<home>/Library/Application Support"),
        "madocuments" => Some("<home>/Documents"),
        "machome" => Some(placeholder::HOME),
        "winappdataroaming" => Some(placeholder::WIN_APP_DATA),
        "winappdatalocal" => Some(placeholder::WIN_LOCAL_APP_DATA),
        "winappdatalocallow" => Some("<home>/AppData/LocalLow"),
        "winmydocuments" => Some(placeholder::WIN_DOCUMENTS),
        "winsavedgames" => Some("<home>/Saved Games"),
        _ => {
            println!("[Steam] unknown root: {}", value);
            None
        }
    }
}

pub fn parse_platform(value: &str) -> Option<Os> {
    match value.to_lowercase().as_ref() {
        "linux" => Some(Os::Linux),
        "macos" => Some(Os::Mac),
        "windows" => Some(Os::Windows),
        "all" => None,
        _ => {
            println!("[Steam] unknown platform: {}", value);
            None
        }
    }
}

pub fn parse_os_comparison(os: Option<String>, comparison: Option<String>) -> Option<Os> {
    let comparison = comparison.unwrap_or_else(|| "=".to_string());
    let os = os.map(|x| x.to_lowercase()).unwrap_or_default();

    match (comparison.as_ref(), os.as_ref()) {
        ("=", "windows") => Some(Os::Windows),
        ("=", "linux") => Some(Os::Linux),
        ("=", "macos") => Some(Os::Mac),
        (x, _) if x != "=" => {
            println!("[Steam] unknown OS operator: {}", x);
            None
        }
        (_, x) if !x.is_empty() => {
            println!("[Steam] unknown OS: {}", x);
            None
        }
        _ => None,
    }
}
