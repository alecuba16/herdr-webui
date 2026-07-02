#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SimpleVersion {
    pub(crate) major: u64,
    pub(crate) minor: u64,
    pub(crate) patch: u64,
}

impl SimpleVersion {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let value = value.strip_prefix('v').unwrap_or(value);
        let core = value
            .find(['-', '+'])
            .map(|index| &value[..index])
            .unwrap_or(value);
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        parts.next().is_none().then_some(Self {
            major,
            minor,
            patch,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BackendCompatibility {
    Compatible,
    ProtocolMismatch,
    TooOld,
    UntestedNewer,
    Unknown,
}

impl BackendCompatibility {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Compatible => "compatible",
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::TooOld => "too_old",
            Self::UntestedNewer => "untested_newer",
            Self::Unknown => "unknown",
        }
    }

    pub(crate) fn message(&self, backend: Option<&str>) -> &'static str {
        match self {
            Self::Compatible => "backend version is supported",
            Self::ProtocolMismatch => {
                "backend direct attach protocol does not match this WebUI build"
            }
            Self::TooOld => "backend version is older than the minimum supported version",
            Self::UntestedNewer => "backend version is newer than the maximum tested version",
            Self::Unknown if backend.is_some() => "backend version could not be parsed",
            Self::Unknown => "backend version is unavailable",
        }
    }
}

pub(crate) fn backend_compatibility(
    backend: Option<&str>,
    protocol: Option<u32>,
    min_supported_protocol: u32,
    max_supported_protocol: u32,
    min_backend_version: &str,
    max_tested_backend_version: &str,
) -> BackendCompatibility {
    match protocol {
        Some(protocol)
            if !(min_supported_protocol..=max_supported_protocol).contains(&protocol) =>
        {
            return BackendCompatibility::ProtocolMismatch
        }
        Some(_) => {}
        None => return BackendCompatibility::Unknown,
    }
    let Some(backend) = backend.and_then(SimpleVersion::parse) else {
        return BackendCompatibility::Unknown;
    };
    let min = SimpleVersion::parse(min_backend_version).expect("valid min backend version");
    let max = SimpleVersion::parse(max_tested_backend_version).expect("valid max backend version");
    if backend < min {
        BackendCompatibility::TooOld
    } else if backend > max {
        BackendCompatibility::UntestedNewer
    } else {
        BackendCompatibility::Compatible
    }
}
