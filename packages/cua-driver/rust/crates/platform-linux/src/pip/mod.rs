//! Native window previews are currently unavailable on Linux.

pub fn initialize(config: &pip_preview::PipConfig) -> anyhow::Result<()> {
    anyhow::ensure!(
        !config.enabled,
        "Window previews are not supported on Linux."
    );
    Ok(())
}
