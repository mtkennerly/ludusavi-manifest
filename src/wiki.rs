use std::collections::{BTreeMap, BTreeSet, HashMap};

use once_cell::sync::Lazy;
use regex::Regex;
use wikitext_parser::{Attribute, TextPiece};

use crate::{
    manifest::{placeholder, Os, Store, Tag},
    path, registry,
    resource::ResourceFile,
    should_cancel, Error, Regularity, State,
};

const SAVE_INTERVAL: u32 = 100;

async fn make_client() -> Result<mediawiki::api::Api, Error> {
    mediawiki::api::Api::new("https://www.pcgamingwiki.com/w/api.php")
        .await
        .map_err(Error::WikiClient)
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct WikiCache(pub BTreeMap<String, WikiCacheEntry>);

impl ResourceFile for WikiCache {
    const FILE_NAME: &'static str = "data/wiki-game-cache.yaml";
}

/// The parser does not handle HTML tags, so we remove some tags that are only used for annotations.
/// Others, like `code` and `sup`, are used both for path segments and annotations,
/// so we can't assume how to replace them properly.
fn preprocess_text(raw: &str) -> String {
    let mut out = raw.to_string();

    static HTML_COMMENT: Lazy<Regex> = Lazy::new(|| Regex::new(r"<!--.+?-->").unwrap());
    static HTML_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r"<ref>.+?</ref>").unwrap());

    for (pattern, replacement) in [(&HTML_COMMENT, ""), (&HTML_REF, "")] {
        out = pattern.replace_all(&out, replacement).to_string();
    }

    out
}

async fn get_page_title(id: u64) -> Result<Option<String>, Error> {
    let wiki = make_client().await?;
    let params = wiki.params_into(&[("action", "query"), ("pageids", id.to_string().as_str())]);

    let res = wiki.get_query_api_json_all(&params).await?;

    for page in res["query"]["pages"]
        .as_object()
        .ok_or(Error::WikiData("query.pages"))?
        .values()
    {
        let found_id = page["pageid"].as_u64().ok_or(Error::WikiData("query.pages[].pageid"))?;
        if found_id == id {
            let title = page["title"].as_str();
            return Ok(title.map(|x| x.to_string()));
        }
    }

    Ok(None)
}

async fn is_game_article(query: &str) -> Result<bool, Error> {
    let wiki = make_client().await?;
    let params = wiki.params_into(&[("action", "query"), ("prop", "categories"), ("titles", query)]);

    let res = wiki.get_query_api_json_all(&params).await?;

    for page in res["query"]["pages"]
        .as_object()
        .ok_or(Error::WikiData("query.pages"))?
        .values()
    {
        let title = page["title"].as_str().ok_or(Error::WikiData("query.pages[].title"))?;
        if title == query {
            if let Some(categories) = page["categories"].as_array() {
                for category in categories {
                    let category_name = category["title"]
                        .as_str()
                        .ok_or(Error::WikiData("query.pages[].categories[].title"))?;
                    if category_name == "Category:Games" {
                        return Ok(true);
                    }
                }
            }
        }
    }

    Ok(false)
}

impl WikiCache {
    pub async fn flag_recent_changes(&mut self, meta: &mut WikiMetaCache) -> Result<(), Error> {
        struct RecentChange {
            page_id: u64,
        }

        let start = meta.last_checked_recent_changes - chrono::Duration::minutes(1);
        let end = chrono::Utc::now();
        println!("Getting recent changes from {} to {}", start, end);

        let wiki = make_client().await?;
        let params = wiki.params_into(&[
            ("action", "query"),
            ("list", "recentchanges"),
            ("rcprop", "title|ids|redirect"),
            ("rcdir", "newer"),
            ("rcstart", &start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            ("rcend", &end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            ("rclimit", "500"),
            ("rcnamespace", "0"),
            ("rctype", "edit|new"),
        ]);

        let res = wiki.get_query_api_json_all(&params).await?;

        let mut changes = BTreeMap::<String, RecentChange>::new();
        for change in res["query"]["recentchanges"]
            .as_array()
            .ok_or(Error::WikiData("query.recentchanges"))?
        {
            let title = change["title"]
                .as_str()
                .ok_or(Error::WikiData("query.recentchanges[].title"))?
                .to_string();
            let page_id = change["pageid"]
                .as_u64()
                .ok_or(Error::WikiData("query.recentchanges[].pageid"))?;
            let redirect = change["redirect"].is_string();

            if !redirect {
                // We don't need the entries for the redirect pages themselves.
                // We'll update our data when we get to the entry for the new page name.
                changes.insert(title, RecentChange { page_id });
            }
        }

        for (title, RecentChange { page_id }) in changes {
            if self.0.contains_key(&title) {
                // Existing entry has been edited.
                println!("[E  ] {}", &title);
                self.0
                    .entry(title.to_string())
                    .and_modify(|x| x.state = State::Outdated);
            } else {
                // Check for a rename.
                let mut old_name = None;
                for (existing_name, existing_info) in &self.0 {
                    if existing_info.page_id == page_id {
                        // We have a confirmed rename.
                        println!("[ M ] {} <<< {}", &title, existing_name);
                        old_name = Some(existing_name.clone());
                        break;
                    }
                }

                match old_name {
                    None => {
                        // Brand new page.
                        match is_game_article(&title).await {
                            Ok(true) => {
                                // It's a game, so add it to the cache.
                                println!("[  C] {}", &title);
                                self.0.insert(
                                    title.to_string(),
                                    WikiCacheEntry {
                                        page_id,
                                        state: State::Outdated,
                                        ..Default::default()
                                    },
                                );
                            }
                            Ok(false) => {
                                // Ignore since it's not relevant.
                            }
                            Err(e) => {
                                eprintln!("Unable to check if article is for a game: {} | {}", &title, e);
                            }
                        }
                    }
                    Some(old_name) => {
                        if let Some(mut info) = self.0.remove(&old_name) {
                            info.page_id = page_id;
                            info.state = State::Outdated;
                            info.renamed_from.push(old_name);
                            self.0.insert(title, info);
                        }
                    }
                }
            }
        }

        meta.last_checked_recent_changes = end;
        Ok(())
    }

    pub async fn add_new_games(&mut self) -> Result<(), Error> {
        let wiki = make_client().await?;
        let params = wiki.params_into(&[
            ("action", "query"),
            ("list", "categorymembers"),
            ("cmtitle", "Category:Games"),
            ("cmlimit", "500"),
        ]);

        let res = wiki.get_query_api_json_all(&params).await?;

        for page in res["query"]["categorymembers"]
            .as_array()
            .ok_or(Error::WikiData("query.categorymembers"))?
        {
            if should_cancel() {
                break;
            }

            let title = page["title"]
                .as_str()
                .ok_or(Error::WikiData("query.categorymembers[].title"))?;
            let page_id = page["pageid"]
                .as_u64()
                .ok_or(Error::WikiData("query.categorymembers[].pageid"))?;

            if self.0.contains_key(title) {
                continue;
            }

            let mut old_name = None;
            for (existing_name, existing_info) in &self.0 {
                if existing_info.page_id == page_id {
                    old_name = Some(existing_name.to_string());
                }
            }

            match old_name {
                None => {
                    self.0.insert(
                        title.to_string(),
                        WikiCacheEntry {
                            page_id,
                            state: State::Outdated,
                            ..Default::default()
                        },
                    );
                }
                Some(old_name) => {
                    let mut data = self.0[&old_name].clone();
                    data.state = State::Outdated;
                    if !data.renamed_from.contains(&old_name) {
                        data.renamed_from.push(old_name.clone());
                    }

                    self.0.insert(title.to_string(), data);
                    self.0.remove(&old_name);
                }
            }
        }

        Ok(())
    }

    pub async fn refresh(
        &mut self,
        outdated_only: bool,
        titles: Option<Vec<String>>,
        limit: Option<usize>,
        from: Option<String>,
    ) -> Result<(), Error> {
        let mut i = 0;
        let titles: Vec<_> = titles.unwrap_or_else(|| {
            self.0
                .iter()
                .filter(|(_, v)| !outdated_only || v.state == State::Outdated)
                .skip_while(|(k, _)| from.as_ref().is_some_and(|from| from != *k))
                .take(limit.unwrap_or(usize::MAX))
                .map(|(k, _)| k.to_string())
                .collect()
        });

        for title in &titles {
            if should_cancel() {
                break;
            }

            let cached = self.0.get(title).cloned().unwrap_or_default();

            println!("Wiki: {}", title);
            let latest = WikiCacheEntry::fetch_from_page(title.clone()).await;
            match latest {
                Ok(mut latest) => {
                    latest.renamed_from = cached.renamed_from.clone();
                    if let Some(new_title) = latest.new_title.take() {
                        println!("  page {} redirected to '{}'", cached.page_id, &new_title);

                        match is_game_article(&new_title).await {
                            Ok(true) => {}
                            Ok(false) => {
                                println!("  page is no longer a game");
                                self.0.remove(title);
                                continue;
                            }
                            Err(e) => {
                                eprintln!("  unable to check if still a game: {e}");
                                return Err(e);
                            }
                        }

                        let cached = self.0.get(&new_title).cloned().unwrap_or_default();
                        latest.renamed_from.extend(cached.renamed_from);
                        latest.renamed_from.push(title.to_string());

                        self.0.remove(title);
                        self.0.insert(new_title, latest);
                    } else {
                        self.0.insert(title.to_string(), latest);
                    }
                }
                Err(Error::PageMissing) => {
                    // Couldn't find it by name, so try again by ID.
                    // This can happen for pages moved without leaving a redirect.
                    // (If they have a redirect, then the recent changes code takes care of it.)
                    let Some(new_title) = get_page_title(cached.page_id).await? else {
                        // Page no longer exists.
                        println!("  page no longer exists");
                        self.0.remove(title);
                        continue;
                    };

                    println!("  page {} renamed to '{}'", cached.page_id, &new_title);

                    match is_game_article(&new_title).await {
                        Ok(true) => {}
                        Ok(false) => {
                            println!("  page is no longer a game");
                            self.0.remove(title);
                            continue;
                        }
                        Err(e) => {
                            eprintln!("  unable to check if still a game: {e}");
                            return Err(e);
                        }
                    }

                    let mut latest = match WikiCacheEntry::fetch_from_page(new_title.clone()).await {
                        Ok(x) => x,
                        Err(Error::PageMissing) => {
                            println!("  page does not exist");
                            self.0.remove(title);
                            continue;
                        }
                        Err(e) => {
                            return Err(e);
                        }
                    };

                    let new_title = latest.new_title.take().unwrap_or(new_title);

                    latest.renamed_from = cached.renamed_from;
                    let cached = self.0.get(&new_title).cloned().unwrap_or_default();
                    latest.renamed_from.extend(cached.renamed_from);
                    latest.renamed_from.push(title.clone());

                    self.0.insert(new_title.clone(), latest);
                    self.0.remove(title);
                }
                Err(e) => {
                    return Err(e);
                }
            }

            i += 1;
            if i % SAVE_INTERVAL == 0 {
                self.save();
                println!("\n:: saved ({i})\n");
            }
        }

        Ok(())
    }
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WikiCacheEntry {
    #[serde(skip_serializing_if = "State::is_handled")]
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gog: Option<u64>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub gog_side: BTreeSet<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lutris: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub malformed: bool,
    pub page_id: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub renamed_from: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steam: Option<u32>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub steam_side: BTreeSet<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<String>,

    /// This will be set after resolving a redirect.
    #[serde(skip)]
    pub new_title: Option<String>,
}

impl WikiCacheEntry {
    pub async fn fetch_from_page(article: String) -> Result<Self, Error> {
        let mut out = WikiCacheEntry {
            state: State::Updated,
            ..Default::default()
        };

        let wiki = make_client().await?;
        let params = wiki.params_into(&[
            ("action", "parse"),
            ("prop", "wikitext"),
            ("page", &article),
            ("redirects", "1"),
        ]);

        let res = wiki
            .get_query_api_json_all(&params)
            .await
            .map_err(|_| Error::PageMissing)?;

        if res["error"]["code"].as_str() == Some("missingtitle") {
            return Err(Error::PageMissing);
        }

        out.page_id = res["parse"]["pageid"].as_u64().ok_or(Error::WikiData("parse.pageid"))?;

        let received_title = res["parse"]["title"].as_str().ok_or(Error::WikiData("parse.title"))?;
        if received_title != article {
            out.new_title = Some(received_title.to_string());
        }

        let raw_wikitext = res["parse"]["wikitext"]["*"]
            .as_str()
            .ok_or(Error::WikiData("parse.wikitext"))?;

        let wikitext = wikitext_parser::parse_wikitext(raw_wikitext, article, |e| {
            out.malformed = true;
            println!("  Error: {}", e);
        });

        for template in wikitext.list_double_brace_expressions() {
            if let TextPiece::DoubleBraceExpression { tag, attributes } = &template {
                match tag.to_string().to_lowercase().trim() {
                    "infobox game" => {
                        for attribute in attributes {
                            match attribute.name.as_deref() {
                                Some("steam appid") => {
                                    if let Ok(value) = preprocess_text(&attribute.value.to_string()).parse::<u32>() {
                                        if value > 0 {
                                            out.steam = Some(value);
                                        }
                                    }
                                }
                                Some("steam appid side") => {
                                    out.steam_side = preprocess_text(&attribute.value.to_string())
                                        .split(',')
                                        .filter_map(|x| x.trim().parse::<u32>().ok())
                                        .filter(|x| *x > 0)
                                        .collect();
                                }
                                Some("gogcom id") => {
                                    if let Ok(value) = preprocess_text(&attribute.value.to_string()).parse::<u64>() {
                                        if value > 0 {
                                            out.gog = Some(value);
                                        }
                                    }
                                }
                                Some("gogcom id side") => {
                                    out.gog_side = preprocess_text(&attribute.value.to_string())
                                        .split(',')
                                        .filter_map(|x| x.trim().parse::<u64>().ok())
                                        .filter(|x| *x > 0)
                                        .collect();
                                }
                                Some("lutris") => {
                                    let value = preprocess_text(&attribute.value.to_string());
                                    if !value.is_empty() {
                                        out.lutris = Some(value);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    "game data" => {
                        for attribute in attributes {
                            for template in &attribute.value.pieces {
                                if let TextPiece::DoubleBraceExpression { tag, attributes } = &template {
                                    let is_save = tag.to_string().to_lowercase() == "game data/saves";
                                    let is_config = tag.to_string().to_lowercase() == "game data/config";

                                    if !is_save && !is_config {
                                        continue;
                                    }

                                    // Ignore templates with an empty path parameter.
                                    if attributes.len() > 1 && attributes[1].value.to_string().is_empty() {
                                        continue;
                                    }

                                    out.templates.push(template.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        Ok(out)
    }

    pub fn parse_paths(&self, article: String) -> Vec<WikiPath> {
        self.parse_all_paths(article)
            .into_iter()
            .filter(|x| x.usable())
            .collect()
    }

    fn parse_all_paths(&self, article: String) -> Vec<WikiPath> {
        let mut out = vec![];

        for raw in &self.templates {
            let preprocessed = preprocess_text(raw);
            let parsed = wikitext_parser::parse_wikitext(&preprocessed, article.clone(), |_| ());
            for template in parsed.list_double_brace_expressions() {
                if let TextPiece::DoubleBraceExpression { tag, attributes } = &template {
                    let is_save = tag.to_string() == "Game data/saves";
                    let is_config = tag.to_string() == "Game data/config";

                    if (!is_save && !is_config) || attributes.len() < 2 {
                        continue;
                    }

                    let platform = attributes[0].value.to_string();
                    for attribute in attributes.iter().skip(1) {
                        let info = flatten_path(attribute)
                            .with_platform(&platform)
                            .with_tags(is_save, is_config)
                            .normalize();
                        out.push(info);
                    }
                }
            }
        }

        out
    }

    pub fn any_irregular_paths(&self, article: String) -> bool {
        for path in self.parse_all_paths(article) {
            if path.irregular() || path.semiregular() {
                return true;
            }
        }
        false
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PathKind {
    File,
    Registry,
}

#[derive(Debug, Default)]
pub struct WikiPath {
    pub composite: String,
    pub regularity: Regularity,
    pub kind: Option<PathKind>,
    pub store: Option<Store>,
    pub os: Option<Os>,
    pub tags: BTreeSet<Tag>,
}

impl WikiPath {
    fn incorporate(&mut self, other: Self) {
        self.regularity = self.regularity.worst(other.regularity);

        if other.kind.is_some() {
            self.kind = other.kind;
        }

        if other.store.is_some() {
            self.store = other.store;
        }

        if other.os.is_some() {
            self.os = other.os;
        }
    }

    pub fn incorporate_text(&mut self, text: &str) {
        if text.contains(['<', '>']) {
            self.regularity = Regularity::Irregular;
        } else {
            self.composite += text;
        }
    }

    pub fn incorporate_raw(&mut self, other: Self) {
        self.incorporate_text(&other.composite);
        self.incorporate(other)
    }

    pub fn incorporate_path(&mut self, other: Self) {
        if let Some(mapped) = MAPPED_PATHS.get(other.composite.to_lowercase().as_str()) {
            self.composite += mapped.manifest;

            if mapped.kind.is_some() {
                self.kind = mapped.kind;
            }

            if mapped.store.is_some() {
                self.store = mapped.store;
            }

            if mapped.os.is_some() {
                self.os = mapped.os;
            }
        } else if !other.composite.is_empty() {
            self.regularity = Regularity::Irregular;
        }

        self.incorporate(other)
    }

    pub fn normalize(mut self) -> Self {
        self.composite = match self.kind {
            None | Some(PathKind::File) => path::normalize(&self.composite),
            Some(PathKind::Registry) => registry::normalize(&self.composite),
        };

        if self.kind.is_none() {
            self.kind = Some(PathKind::File);
        }

        self
    }

    pub fn with_platform(mut self, platform: &str) -> Self {
        match platform.to_lowercase().trim() {
            "windows" => {
                self.os = Some(Os::Windows);
            }
            "os x" => {
                self.os = Some(Os::Mac);
            }
            "linux" => {
                self.os = Some(Os::Linux);
            }
            "dos" => {
                self.os = Some(Os::Dos);
            }
            "steam" => {
                self.store = Some(Store::Steam);
            }
            "microsoft store" => {
                self.os = Some(Os::Windows);
                self.store = Some(Store::Microsoft);
            }
            "gog.com" => {
                self.store = Some(Store::Gog);
            }
            "epic games" => {
                self.store = Some(Store::Epic);
            }
            "uplay" => {
                self.store = Some(Store::Uplay);
            }
            "origin" => {
                self.store = Some(Store::Origin);
            }
            _ => {}
        }

        self
    }

    pub fn with_tags(mut self, save: bool, config: bool) -> Self {
        if save {
            self.tags.insert(Tag::Save);
        }
        if config {
            self.tags.insert(Tag::Config);
        }
        self
    }

    fn irregular(&self) -> bool {
        self.regularity == Regularity::Irregular || self.composite.contains("{{")
    }

    fn semiregular(&self) -> bool {
        self.regularity == Regularity::Semiregular
    }

    pub fn usable(&self) -> bool {
        match self.kind {
            None | Some(PathKind::File) => path::usable(&self.composite) && !self.irregular(),
            Some(PathKind::Registry) => registry::usable(&self.composite) && !self.irregular(),
        }
    }
}

#[derive(Debug, Default)]
pub struct MappedPath {
    pub manifest: &'static str,
    pub os: Option<Os>,
    pub store: Option<Store>,
    pub kind: Option<PathKind>,
}

pub fn flatten_path(attribute: &Attribute) -> WikiPath {
    let mut out = WikiPath::default();

    for piece in &attribute.value.pieces {
        match piece {
            TextPiece::Text { text, .. } => {
                out.incorporate_text(text);
            }
            TextPiece::DoubleBraceExpression { tag, attributes } => match tag.to_string().to_lowercase().trim() {
                "p" | "path" => {
                    for attribute in attributes {
                        let flat = flatten_path(attribute);
                        out.incorporate_path(flat);
                    }
                }
                "code" | "file" => {
                    // These could be used for a path segment or for a note, but we assume path segment.
                    out.regularity = Regularity::Semiregular;
                    out.composite += "*";
                }
                "localizedpath" => {
                    for attribute in attributes {
                        let flat = flatten_path(attribute);
                        out.incorporate_raw(flat);
                    }
                }
                "note" | "cn" => {
                    // Ignored.
                }
                _ => {
                    out.regularity = Regularity::Irregular;
                }
            },
            TextPiece::InternalLink { .. } => {}
            TextPiece::ListItem { .. } => {}
        }
    }

    out
}

/// https://www.pcgamingwiki.com/wiki/Template:Path
static MAPPED_PATHS: Lazy<HashMap<&'static str, MappedPath>> = Lazy::new(|| {
    HashMap::from_iter([
        // General
        (
            "game",
            MappedPath {
                manifest: placeholder::BASE,
                ..Default::default()
            },
        ),
        (
            "uid",
            MappedPath {
                manifest: placeholder::STORE_USER_ID,
                ..Default::default()
            },
        ),
        (
            "steam",
            MappedPath {
                manifest: placeholder::ROOT,
                store: Some(Store::Steam),
                ..Default::default()
            },
        ),
        (
            "uplay",
            MappedPath {
                manifest: placeholder::ROOT,
                store: Some(Store::Uplay),
                ..Default::default()
            },
        ),
        (
            "ubisoftconnect",
            MappedPath {
                manifest: placeholder::ROOT,
                store: Some(Store::Uplay),
                ..Default::default()
            },
        ),
        // Windows registry
        (
            "hkcu",
            MappedPath {
                manifest: "HKEY_CURRENT_USER",
                os: Some(Os::Windows),
                kind: Some(PathKind::Registry),
                ..Default::default()
            },
        ),
        (
            "hkey_current_user",
            MappedPath {
                manifest: "HKEY_CURRENT_USER",
                os: Some(Os::Windows),
                kind: Some(PathKind::Registry),
                ..Default::default()
            },
        ),
        (
            "hklm",
            MappedPath {
                manifest: "HKEY_LOCAL_MACHINE",
                os: Some(Os::Windows),
                kind: Some(PathKind::Registry),
                ..Default::default()
            },
        ),
        (
            "hkey_local_machine",
            MappedPath {
                manifest: "HKEY_LOCAL_MACHINE",
                os: Some(Os::Windows),
                kind: Some(PathKind::Registry),
                ..Default::default()
            },
        ),
        (
            "wow64",
            MappedPath {
                manifest: "WOW6432Node",
                os: Some(Os::Windows),
                kind: Some(PathKind::Registry),
                ..Default::default()
            },
        ),
        // Windows filesystem
        (
            "username",
            MappedPath {
                manifest: placeholder::OS_USER_NAME,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "userprofile",
            MappedPath {
                manifest: placeholder::HOME,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "userprofile\\documents",
            MappedPath {
                manifest: placeholder::WIN_DOCUMENTS,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "userprofile\\appdata\\locallow",
            MappedPath {
                manifest: "<home>/AppData/LocalLow",
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "appdata",
            MappedPath {
                manifest: placeholder::WIN_APP_DATA,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "localappdata",
            MappedPath {
                manifest: placeholder::WIN_LOCAL_APP_DATA,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "public",
            MappedPath {
                manifest: placeholder::WIN_PUBLIC,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "allusersprofile",
            MappedPath {
                manifest: placeholder::WIN_PROGRAM_DATA,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "programdata",
            MappedPath {
                manifest: placeholder::WIN_PROGRAM_DATA,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "programfiles",
            MappedPath {
                manifest: "C:/Program Files",
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "windir",
            MappedPath {
                manifest: placeholder::WIN_DIR,
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        (
            "syswow64",
            MappedPath {
                manifest: "<winDir>/SysWOW64",
                os: Some(Os::Windows),
                ..Default::default()
            },
        ),
        // Mac
        (
            "osxhome",
            MappedPath {
                manifest: placeholder::HOME,
                os: Some(Os::Mac),
                ..Default::default()
            },
        ),
        // Linux
        (
            "linuxhome",
            MappedPath {
                manifest: placeholder::HOME,
                os: Some(Os::Linux),
                ..Default::default()
            },
        ),
        (
            "xdgdatahome",
            MappedPath {
                manifest: placeholder::XDG_DATA,
                os: Some(Os::Linux),
                ..Default::default()
            },
        ),
        (
            "xdgconfighome",
            MappedPath {
                manifest: placeholder::XDG_CONFIG,
                os: Some(Os::Linux),
                ..Default::default()
            },
        ),
    ])
});

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMetaCache {
    pub last_checked_recent_changes: chrono::DateTime<chrono::Utc>,
}

impl ResourceFile for WikiMetaCache {
    const FILE_NAME: &'static str = "data/wiki-meta-cache.yaml";

    fn initialize(mut self) -> Self {
        self.last_checked_recent_changes = chrono::Utc::now() - chrono::Duration::days(1);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_is_game_article() {
        assert!(matches!(is_game_article("Celeste").await, Ok(true)));
        assert!(matches!(is_game_article("Template:Path").await, Ok(false)));
    }
}
