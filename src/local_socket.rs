use std::io;
use std::path::Path;

pub type LocalStream = interprocess::local_socket::Stream;

pub fn connect_local_stream(path: &Path) -> io::Result<LocalStream> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        let name = path.to_fs_name::<GenericFilePath>()?;
        LocalStream::connect(name)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{prelude::*, GenericNamespaced};
        let name = path.to_string_lossy().to_string();
        let name = name.to_ns_name::<GenericNamespaced>()?;
        LocalStream::connect(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nul_in_the_path_fails_fs_name_conversion() {
        // A NUL byte is invalid in a filesystem socket name, so
        // to_fs_name errors before any connect attempt happens.
        let bad = std::path::Path::new("/tmp/bad\u{0}socket");
        assert!(connect_local_stream(bad).is_err());
    }
}
