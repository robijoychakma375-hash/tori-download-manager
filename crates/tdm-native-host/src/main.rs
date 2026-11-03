#[tokio::main]
async fn main() -> std::io::Result<()> {
    tdm_native_host::run().await
}
