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
    expected_protocol: u32,
    min_backend_version: &str,
    max_tested_backend_version: &str,
) -> BackendCompatibility {
    match protocol {
        Some(protocol) if protocol != expected_protocol => {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_semver_variants_and_rejects_invalid_shapes() {
        assert_eq!(
            SimpleVersion::parse("v1.2.3-beta+build"),
            Some(SimpleVersion {
                major: 1,
                minor: 2,
                patch: 3,
            })
        );
        assert!(SimpleVersion::parse("1.2").is_none());
        assert!(SimpleVersion::parse("1.2.3.4").is_none());
        assert!(SimpleVersion::parse("x.2.3").is_none());
    }

    #[test]
    fn compatibility_messages_cover_all_statuses() {
        let cases = [
            (
                BackendCompatibility::Compatible,
                Some("0.7.0"),
                "compatible",
                "backend version is supported",
            ),
            (
                BackendCompatibility::ProtocolMismatch,
                Some("0.7.0"),
                "protocol_mismatch",
                "backend direct attach protocol does not match this WebUI build",
            ),
            (
                BackendCompatibility::TooOld,
                Some("0.6.9"),
                "too_old",
                "backend version is older than the minimum supported version",
            ),
            (
                BackendCompatibility::UntestedNewer,
                Some("0.8.0"),
                "untested_newer",
                "backend version is newer than the maximum tested version",
            ),
            (
                BackendCompatibility::Unknown,
                Some("dev"),
                "unknown",
                "backend version could not be parsed",
            ),
            (
                BackendCompatibility::Unknown,
                None,
                "unknown",
                "backend version is unavailable",
            ),
        ];

        for (status, backend, name, message) in cases {
            assert_eq!(status.as_str(), name);
            assert_eq!(status.message(backend), message);
        }
    }

    #[test]
    fn backend_compatibility_prioritizes_protocol_then_version_range() {
        assert_eq!(
            backend_compatibility(Some("0.7.0"), Some(13), 14, "0.7.0", "0.7.1"),
            BackendCompatibility::ProtocolMismatch
        );
        assert_eq!(
            backend_compatibility(Some("0.7.0"), None, 14, "0.7.0", "0.7.1"),
            BackendCompatibility::Unknown
        );
        assert_eq!(
            backend_compatibility(Some("bad"), Some(14), 14, "0.7.0", "0.7.1"),
            BackendCompatibility::Unknown
        );
        assert_eq!(
            backend_compatibility(Some("0.6.9"), Some(14), 14, "0.7.0", "0.7.1"),
            BackendCompatibility::TooOld
        );
        assert_eq!(
            backend_compatibility(Some("0.8.0"), Some(14), 14, "0.7.0", "0.7.1"),
            BackendCompatibility::UntestedNewer
        );
        assert_eq!(
            backend_compatibility(Some("0.7.1"), Some(14), 14, "0.7.0", "0.7.1"),
            BackendCompatibility::Compatible
        );
    }
}
