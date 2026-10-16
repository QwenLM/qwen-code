use pip_preview::{PipBackend, PipBackendFactory, PipConfig};

pub struct LinuxPipBackendFactory;

impl PipBackendFactory for LinuxPipBackendFactory {
    fn start(&self, _cfg: &PipConfig) -> anyhow::Result<Box<dyn PipBackend>> {
        Err(anyhow::anyhow!(
            "PiP preview is not yet implemented on Linux — track \
             trycua/cua follow-up issue for status"
        ))
    }
}
