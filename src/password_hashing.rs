//! Password hashing for the WebUI login credentials.
//!
//! Stored credentials must never let the original password be recovered:
//! the settings file can be leaked through backups, dotfile syncs, or a
//! stolen laptop disk image. Every persisted password is an Argon2id PHC
//! string (random salt per hash), so an attacker with the file must brute
//! force the password instead of reading it.
//!
//! Argon2id parameters sit at the OWASP baseline (19 MiB memory, 2 passes),
//! tuned down from the config-recommendation 46 MiB: login happens on an
//! interactive request path and the server is a single-user local tool,
//! so a ~30 ms verify keeps the brute-force cost meaningful without making
//! the login form feel slow.

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use std::io;

/// Hash a plaintext password into a PHC string for persistence.
pub(crate) fn hash_password(password: &str) -> io::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))
}

/// Verify a plaintext attempt against a stored PHC string. Returns false
/// for any unparsable stored value: a malformed hash must never authorize
/// a login, and the login rate limiter already throttles brute force.
pub(crate) fn verify_password(stored_phc: &str, attempt: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(attempt.as_bytes(), &parsed)
        .is_ok()
}

/// Whether a stored value looks like a PHC string produced by
/// [`hash_password`] (Argon2id encoding). Used by the settings loader to
/// decide whether a legacy plaintext `password` still needs migrating.
pub(crate) fn is_password_hash(value: &str) -> bool {
    value.starts_with("$argon2id$")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_phc_and_not_the_password() {
        let hash = hash_password("hunter2").unwrap();
        assert!(is_password_hash(&hash), "stored value must be PHC: {hash}");
        assert!(!hash.contains("hunter2"));
        // Random salt per hash: two hashes of one password differ.
        let again = hash_password("hunter2").unwrap();
        assert_ne!(hash, again);
    }

    #[test]
    fn verify_accepts_correct_and_rejects_wrong_password() {
        let hash = hash_password("correct horse").unwrap();
        assert!(verify_password(&hash, "correct horse"));
        assert!(!verify_password(&hash, "wrong"));
        assert!(!verify_password(&hash, ""));
    }

    #[test]
    fn malformed_stored_hash_never_verifies() {
        assert!(!verify_password("plaintext-leaked", "plaintext-leaked"));
        assert!(!verify_password("", "anything"));
        assert!(!verify_password("$argon2id$garbage", "anything"));
    }

    #[test]
    fn is_password_hash_detects_phc_prefix_only() {
        assert!(is_password_hash(
            "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$hash"
        ));
        assert!(!is_password_hash("plain-secret"));
        assert!(!is_password_hash("$2b$12$bcrypt-style"));
    }
}
