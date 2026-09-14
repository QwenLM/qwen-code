use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use cua_driver_contract::PasteFormat;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{class, declare_class, msg_send, msg_send_id, mutability, ClassType, DeclaredClass};
use objc2_app_kit::{
    NSAttributedStringDocumentFormats, NSCharacterEncodingDocumentOption,
    NSDocumentTypeDocumentOption, NSHTMLTextDocumentType, NSPasteboard,
    NSPasteboardContentsOptions, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType,
    NSPasteboardWriting, NSTimeoutDocumentOption, NSWebPreferencesDocumentOption,
    NSWebResourceLoadDelegateDocumentOption,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSData, NSDictionary, NSNumber, NSObject, NSObjectProtocol,
    NSRange, NSString,
};

pub(super) type Representations = Vec<(String, Vec<u8>)>;
type Snapshot = Vec<Representations>;

pub(super) fn queue() -> Arc<tokio::sync::Mutex<()>> {
    static QUEUE: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    Arc::clone(QUEUE.get_or_init(|| Arc::new(tokio::sync::Mutex::new(()))))
}

#[derive(Default)]
pub(super) struct Signals {
    pub consumed: AtomicBool,
    pub written: AtomicBool,
    pub finished: AtomicBool,
    pub effect: AtomicBool,
}

impl Signals {
    pub(super) fn observe_effect(&self) {
        if self.consumed.load(Ordering::Acquire) && self.written.load(Ordering::Acquire) {
            self.effect.store(true, Ordering::Release);
        }
    }
}

struct ProviderIvars {
    representations: Representations,
    signals: Arc<Signals>,
}

declare_class!(
    struct PasteProvider;

    unsafe impl ClassType for PasteProvider {
        type Super = NSObject;
        type Mutability = mutability::InteriorMutable;
        const NAME: &'static str = "QwenCuaPasteProvider";
    }

    impl DeclaredClass for PasteProvider {
        type Ivars = ProviderIvars;
    }

    unsafe impl NSObjectProtocol for PasteProvider {}

    unsafe impl NSPasteboardItemDataProvider for PasteProvider {
        #[method(pasteboard:item:provideDataForType:)]
        unsafe fn provide_data(
            &self,
            _pasteboard: Option<&NSPasteboard>,
            item: &NSPasteboardItem,
            kind: &NSPasteboardType,
        ) {
            let requested = kind.to_string();
            if let Some((_, bytes)) = self.ivars().representations.iter().find(|(key, _)| key == &requested) {
                if item.setData_forType(&NSData::with_bytes(bytes), kind) {
                    self.ivars().signals.consumed.store(true, Ordering::Release);
                }
            }
        }

        #[method(pasteboardFinishedWithDataProvider:)]
        unsafe fn finished(&self, _pasteboard: &NSPasteboard) {
            self.ivars().signals.finished.store(true, Ordering::Release);
        }
    }
);

impl PasteProvider {
    fn new(representations: Representations, signals: Arc<Signals>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ProviderIvars {
            representations,
            signals,
        });
        unsafe { msg_send_id![super(this), init] }
    }
}

declare_class!(
    struct ResourceLoadBlocker;

    unsafe impl ClassType for ResourceLoadBlocker {
        type Super = NSObject;
        type Mutability = mutability::InteriorMutable;
        const NAME: &'static str = "QwenCuaPasteResourceLoadBlocker";
    }

    impl DeclaredClass for ResourceLoadBlocker { type Ivars = (); }
    unsafe impl NSObjectProtocol for ResourceLoadBlocker {}

    unsafe impl ResourceLoadBlocker {
        #[method(webView:resource:willSendRequest:redirectResponse:fromDataSource:)]
        fn block_resource(
            &self,
            _view: *mut AnyObject,
            _resource: *mut AnyObject,
            _request: *mut AnyObject,
            _response: *mut AnyObject,
            _source: *mut AnyObject,
        ) -> *mut AnyObject {
            std::ptr::null_mut()
        }
    }
);

impl ResourceLoadBlocker {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send_id![super(this), init] }
    }
}

fn markdown_html(text: &str) -> String {
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new(text));
    html
}

#[link(name = "WebKit", kind = "framework")]
extern "C" {}

// AppKit's HTML importer uses WebKit and must execute on its main thread.
// Nothing in this conversion path reads or modifies the pasteboard.
unsafe fn rich_representations(html: String) -> anyhow::Result<Representations> {
    let blocker = ResourceLoadBlocker::new();
    let preferences: Retained<AnyObject> = msg_send_id![class!(WebPreferences), new];
    let _: () = msg_send![&*preferences, setJavaScriptEnabled: false];
    let _: () = msg_send![&*preferences, setJavaEnabled: false];
    let _: () = msg_send![&*preferences, setPlugInsEnabled: false];
    let _: () = msg_send![&*preferences, setLoadsImagesAutomatically: false];
    let encoding = NSNumber::new_usize(4); // NSUTF8StringEncoding
    let timeout = NSNumber::new_f64(2.0);
    let options = NSDictionary::<NSString, AnyObject>::from_vec(
        &[
            NSDocumentTypeDocumentOption,
            NSCharacterEncodingDocumentOption,
            NSTimeoutDocumentOption,
            NSWebResourceLoadDelegateDocumentOption,
            NSWebPreferencesDocumentOption,
        ],
        vec![
            Retained::cast(NSString::from_str(&NSHTMLTextDocumentType.to_string())),
            Retained::cast(encoding),
            Retained::cast(timeout),
            Retained::cast(blocker),
            preferences,
        ],
    );
    let attributed = NSAttributedString::initWithData_options_documentAttributes_error(
        NSAttributedString::alloc(),
        &NSData::with_bytes(html.as_bytes()),
        &options,
        None,
    )
    .map_err(|_| anyhow!("HTML could not be converted to attributed text"))?;
    let rtf = attributed
        .RTFFromRange_documentAttributes(NSRange::new(0, attributed.length()), &NSDictionary::new())
        .ok_or_else(|| anyhow!("attributed text could not be converted to RTF"))?;
    Ok(vec![
        ("public.html".into(), html.into_bytes()),
        ("public.rtf".into(), rtf.bytes().to_vec()),
        (
            "public.utf8-plain-text".into(),
            attributed.string().to_string().into_bytes(),
        ),
    ])
}

struct Conversion {
    html: String,
    sender: tokio::sync::oneshot::Sender<Result<Representations, String>>,
}

extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: unsafe extern "C" fn(*mut c_void),
    );
}

unsafe extern "C" fn convert_on_main(context: *mut c_void) {
    let Conversion { html, sender } = *Box::from_raw(context as *mut Conversion);
    if sender.is_closed() {
        return;
    }
    let result = objc2::rc::autoreleasepool(|_| rich_representations(html));
    let _ = sender.send(result.map_err(|error| error.to_string()));
}

pub(super) async fn convert(text: String, format: PasteFormat) -> anyhow::Result<Representations> {
    let html = match format {
        PasteFormat::Text => return Ok(vec![("public.utf8-plain-text".into(), text.into_bytes())]),
        PasteFormat::Md => markdown_html(&text),
        PasteFormat::Html => text,
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let request = Box::new(Conversion { html, sender });
    unsafe {
        dispatch_async_f(
            &raw const _dispatch_main_q,
            Box::into_raw(request).cast(),
            convert_on_main,
        );
    }
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .context("timed out converting rich paste content on the AppKit main thread")?
        .context("rich paste conversion stopped")?
        .map_err(anyhow::Error::msg)
}

unsafe fn snapshot_items(items: &NSArray<NSPasteboardItem>) -> anyhow::Result<Snapshot> {
    let mut snapshot = Vec::with_capacity(items.len());
    for item in items.to_vec() {
        let types = item.types();
        let mut representations = Vec::with_capacity(types.len());
        for kind in types.to_vec() {
            let data = item.dataForType(kind).ok_or_else(|| {
                anyhow!("clipboard snapshot is incomplete; original clipboard was not modified")
            })?;
            representations.push((kind.to_string(), data.bytes().to_vec()));
        }
        snapshot.push(representations);
    }
    Ok(snapshot)
}

unsafe fn restored_items(
    snapshot: &Snapshot,
) -> anyhow::Result<Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>>> {
    let mut restored = Vec::with_capacity(snapshot.len());
    for representations in snapshot {
        let item = NSPasteboardItem::new();
        for (kind, bytes) in representations {
            if !item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind)) {
                bail!("could not prepare complete clipboard restoration");
            }
        }
        restored.push(ProtocolObject::from_retained(item));
    }
    Ok(NSArray::from_vec(restored))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Restoration {
    Restored,
    ExternalChange,
}

struct NativeTransaction {
    board: Retained<NSPasteboard>,
    restored: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>>,
    _provider: Retained<PasteProvider>,
    expected: isize,
    active: bool,
}

impl NativeTransaction {
    fn begin_on(
        board: Retained<NSPasteboard>,
        content: Representations,
        signals: Arc<Signals>,
    ) -> anyhow::Result<Self> {
        unsafe {
            let types = NSArray::from_vec(
                content
                    .iter()
                    .map(|(kind, _)| NSString::from_str(kind))
                    .collect(),
            );
            let provider = PasteProvider::new(content, Arc::clone(&signals));
            let item = NSPasteboardItem::new();
            if !item.setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &types) {
                bail!("could not register paste content provider");
            }
            let before = board.changeCount();
            let snapshot = match board.pasteboardItems() {
                Some(items) => snapshot_items(&items)?,
                None if board.types().is_some_and(|types| !types.is_empty()) => {
                    bail!("clipboard items are unavailable; original clipboard was not modified");
                }
                None => Vec::new(),
            };
            let restored = restored_items(&snapshot)?;
            if board.changeCount() != before {
                bail!("clipboard changed during snapshot; new clipboard was not modified");
            }
            let expected = board.prepareForNewContentsWithOptions(
                NSPasteboardContentsOptions::NSPasteboardContentsCurrentHostOnly,
            );
            let mut transaction = Self {
                board,
                restored,
                _provider: provider,
                expected,
                active: true,
            };
            let items = NSArray::from_vec(vec![ProtocolObject::from_retained(item)]);
            if !transaction.owns_clipboard() {
                bail!("clipboard changed before paste content was written; new clipboard was preserved");
            }
            if !transaction.board.writeObjects(&items) {
                let restore = transaction.restore();
                return Err(match restore {
                    Ok(_) => anyhow!("could not write generated paste content"),
                    Err(error) => error.context("could not write generated paste content"),
                });
            }
            signals.written.store(true, Ordering::Release);
            Ok(transaction)
        }
    }

    pub(super) fn owns_clipboard(&self) -> bool {
        unsafe { self.board.changeCount() == self.expected }
    }

    pub(super) fn restore(&mut self) -> anyhow::Result<Restoration> {
        if !self.active {
            bail!("paste clipboard transaction already ended");
        }
        self.active = false;
        if !self.owns_clipboard() {
            return Ok(Restoration::ExternalChange);
        }
        unsafe {
            // All item/type writes were checked while constructing `restored`,
            // before clearing. changeCount is the system's non-atomic ownership check.
            self.board.clearContents();
            if !self.restored.is_empty() && !self.board.writeObjects(&self.restored) {
                bail!("could not restore the original clipboard");
            }
        }
        Ok(Restoration::Restored)
    }
}

impl Drop for NativeTransaction {
    fn drop(&mut self) {
        if self.active {
            if let Err(error) = self.restore() {
                tracing::error!("paste clipboard cleanup failed: {error}");
            }
        }
    }
}

thread_local! {
    static TRANSACTIONS: RefCell<HashMap<u64, NativeTransaction>> = RefCell::new(HashMap::new());
}

struct MainCall<T> {
    work: Box<dyn FnOnce() -> anyhow::Result<T> + Send>,
    sender: std::sync::mpsc::Sender<anyhow::Result<T>>,
}

unsafe extern "C" fn call_on_main<T: Send + 'static>(context: *mut c_void) {
    let MainCall { work, sender } = *Box::from_raw(context.cast::<MainCall<T>>());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| work())
    }))
    .unwrap_or_else(|_| Err(anyhow!("pasteboard main-thread operation panicked")));
    let _ = sender.send(result);
}

fn main_call<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    if objc2_foundation::MainThreadMarker::new().is_some() {
        return work();
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let request = Box::new(MainCall {
        work: Box::new(work),
        sender,
    });
    unsafe {
        dispatch_async_f(
            &raw const _dispatch_main_q,
            Box::into_raw(request).cast(),
            call_on_main::<T>,
        );
    }
    // This worker keeps its mutation/clipboard leases until the main-thread
    // operation finishes. A timeout here could leave a late clipboard write
    // running after cancellation and after a subsequent transaction begins.
    receiver
        .recv()
        .context("pasteboard main-thread operation stopped")?
}

pub(super) struct Transaction {
    id: u64,
    active: bool,
}

impl Transaction {
    pub(super) fn begin(content: Representations, signals: Arc<Signals>) -> anyhow::Result<Self> {
        Self::on_board(content, signals, || unsafe {
            NSPasteboard::generalPasteboard()
        })
    }

    fn on_board(
        content: Representations,
        signals: Arc<Signals>,
        board: impl FnOnce() -> Retained<NSPasteboard> + Send + 'static,
    ) -> anyhow::Result<Self> {
        main_call(move || {
            let transaction = NativeTransaction::begin_on(board(), content, signals)?;
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            TRANSACTIONS.with(|transactions| {
                transactions.borrow_mut().insert(id, transaction);
            });
            Ok(Self { id, active: true })
        })
    }

    pub(super) fn owns_clipboard(&self) -> bool {
        let id = self.id;
        main_call(move || {
            TRANSACTIONS.with(|transactions| {
                Ok(transactions
                    .borrow()
                    .get(&id)
                    .is_some_and(NativeTransaction::owns_clipboard))
            })
        })
        .unwrap_or(false)
    }

    pub(super) fn restore(&mut self) -> anyhow::Result<Restoration> {
        if !self.active {
            bail!("paste clipboard transaction already ended");
        }
        self.active = false;
        let id = self.id;
        main_call(move || {
            let mut transaction = TRANSACTIONS
                .with(|transactions| transactions.borrow_mut().remove(&id))
                .ok_or_else(|| anyhow!("paste clipboard transaction is unavailable"))?;
            transaction.restore()
        })
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        if self.active {
            if let Err(error) = self.restore() {
                tracing::error!("paste clipboard cleanup failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_preserves_semantic_rich_content() {
        let html = markdown_html("**粗体** 😀\n\n- one\n- [two](https://example.com)");
        assert!(html.contains("<strong>粗体</strong> 😀"));
        assert!(html.contains("<ul>"));
        assert!(html.contains("href=\"https://example.com\""));
    }

    #[test]
    fn detached_items_preserve_every_binary_type_and_item() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let snapshot = vec![
                vec![
                    (
                        "public.utf8-plain-text".into(),
                        "你好😀".as_bytes().to_vec(),
                    ),
                    ("com.example.private".into(), vec![0, 255, 17, 0]),
                ],
                vec![("public.png".into(), vec![137, 80, 78, 71])],
            ];
            let objects = restored_items(&snapshot).unwrap();
            let items: &NSArray<NSPasteboardItem> =
                &*(&*objects as *const _ as *const NSArray<NSPasteboardItem>);
            assert_eq!(snapshot_items(items).unwrap(), snapshot);
        });
    }

    #[test]
    fn provider_real_selector_supplies_only_requested_type() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let signals = Arc::new(Signals::default());
            let provider = PasteProvider::new(
                vec![("public.utf8-plain-text".into(), b"payload".to_vec())],
                Arc::clone(&signals),
            );
            let item = NSPasteboardItem::new();
            let missing = NSString::from_str("com.example.missing");
            let _: () = msg_send![&*provider, pasteboard: std::ptr::null::<NSPasteboard>(), item: &*item, provideDataForType: &*missing];
            assert!(!signals.consumed.load(Ordering::Acquire));
            let kind = NSString::from_str("public.utf8-plain-text");
            let _: () = msg_send![&*provider, pasteboard: std::ptr::null::<NSPasteboard>(), item: &*item, provideDataForType: &*kind];
            assert_eq!(item.dataForType(&kind).unwrap().bytes(), b"payload");
            assert!(signals.consumed.load(Ordering::Acquire));
            assert!(!signals.effect.load(Ordering::Acquire));
        });
    }

    #[test]
    fn incomplete_snapshot_refuses_missing_type_bytes() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let provider = PasteProvider::new(Vec::new(), Arc::new(Signals::default()));
            let item = NSPasteboardItem::new();
            assert!(item.setDataProvider_forTypes(
                ProtocolObject::from_ref(&*provider),
                &NSArray::from_vec(vec![NSString::from_str("com.example.unavailable")])
            ));
            assert!(snapshot_items(&NSArray::from_vec(vec![item])).is_err());
        });
    }

    #[test]
    fn resource_blocker_real_selector_rejects_requests() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let blocker = ResourceLoadBlocker::new();
            let request = NSObject::new();
            let nil = std::ptr::null::<AnyObject>();
            let result: *mut AnyObject = msg_send![&*blocker, webView: nil, resource: nil, willSendRequest: &*request, redirectResponse: nil, fromDataSource: nil];
            assert!(result.is_null());
        });
    }

    #[test]
    fn effect_notification_must_follow_write_and_supply() {
        let signals = Signals::default();
        signals.observe_effect();
        signals.consumed.store(true, Ordering::Release);
        signals.observe_effect();
        assert!(!signals.effect.load(Ordering::Acquire));
        signals.written.store(true, Ordering::Release);
        signals.observe_effect();
        assert!(signals.effect.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn paste_queue_serializes_different_apps_and_cancellation_releases_waiter() {
        let serial = queue();
        let first = Arc::clone(&serial).lock_owned().await;
        let second = tokio::spawn(async move { serial.lock_owned().await });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        second.abort();
        assert!(second.await.unwrap_err().is_cancelled());
        drop(first);
        assert!(queue().try_lock_owned().is_ok());
    }
}
