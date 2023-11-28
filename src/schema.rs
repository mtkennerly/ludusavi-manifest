use crate::{manifest::Manifest, resource::ResourceFile, Error, REPO};

pub fn validate_manifest(manifest: &Manifest) -> Result<(), Error> {
    let manifest: serde_json::Value = serde_yaml::from_str(&manifest.serialize()).unwrap();

    let normal: serde_json::Value = serde_yaml::from_str(&read_data("schema.yaml")).unwrap();
    let strict: serde_json::Value = serde_yaml::from_str(&read_data("schema.strict.yaml")).unwrap();

    for schema in [normal, strict] {
        if !check(&schema, &manifest) {
            return Err(Error::ManifestSchema);
        }
    }

    Ok(())
}

fn read_data(file: &str) -> String {
    std::fs::read_to_string(format!("{}/data/{}", REPO, file)).unwrap()
}

fn check(schema: &serde_json::Value, instance: &serde_json::Value) -> bool {
    let mut valid = true;
    let compiled = jsonschema::JSONSchema::compile(schema).unwrap();
    if let Err(errors) = compiled.validate(instance) {
        valid = false;
        for error in errors {
            println!("Schema error: {}  |  {}", error, error.instance_path);
        }
    }
    valid
}
