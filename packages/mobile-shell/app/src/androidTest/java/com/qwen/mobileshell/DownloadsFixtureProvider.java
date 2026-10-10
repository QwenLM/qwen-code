package com.qwen.mobileshell;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;

// Runs in the test APK's separate process, without the target APK's Kotlin runtime.
public class DownloadsFixtureProvider extends ContentProvider {
    public static final Uri URI = Uri.parse("content://com.qwen.mobileshell.test.downloads/file");
    private static final String TARGET = "com.qwen.mobileshell";
    private CountDownLatch resume = new CountDownLatch(1);
    private final CRC32 checksum = new CRC32();
    private int count;
    private boolean opened;
    private boolean done;
    private String error;

    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        Context owner = getContext();
        try {
            if (Binder.getCallingUid() != owner.getPackageManager().getApplicationInfo(TARGET, 0).uid) {
                throw new SecurityException("Only the target app can control this fixture");
            }
        } catch (PackageManager.NameNotFoundException failure) {
            throw new SecurityException(failure);
        }
        if ("grant".equals(method)) {
            synchronized (this) {
                if (opened && !done) throw new IllegalStateException("Previous fixture write is still running");
                resume = new CountDownLatch(1);
                checksum.reset();
                count = 0;
                opened = false;
                done = false;
                error = null;
            }
            long identity = Binder.clearCallingIdentity();
            try { owner.grantUriPermission(TARGET, URI, Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
            finally { Binder.restoreCallingIdentity(identity); }
        } else if ("resume".equals(method)) {
            synchronized (this) { resume.countDown(); }
        } else if (!"status".equals(method)) {
            throw new IllegalArgumentException("Unknown fixture operation");
        }
        synchronized (this) {
            Bundle result = new Bundle();
            result.putInt("count", count);
            result.putLong("crc", checksum.getValue());
            result.putBoolean("done", done);
            result.putString("error", error);
            return result;
        }
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!URI.equals(uri) || !"wt".equals(mode)) throw new FileNotFoundException("Invalid fixture destination");
        final CountDownLatch gate;
        synchronized (this) {
            if (opened) throw new FileNotFoundException("Fixture destination is already open");
            opened = true;
            gate = resume;
        }
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            new Thread(() -> {
                try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
                    byte[] bytes = new byte[4096];
                    int size;
                    while ((size = input.read(bytes)) != -1) {
                        synchronized (this) { count += size; checksum.update(bytes, 0, size); }
                        if (!gate.await(20, TimeUnit.SECONDS)) throw new IOException("Fixture was not resumed");
                    }
                } catch (Exception failure) {
                    synchronized (this) { error = failure.toString(); }
                } finally {
                    synchronized (this) { done = true; }
                }
            }, "download-fixture-reader").start();
            return pipe[1];
        } catch (IOException failure) {
            throw new FileNotFoundException(failure.toString());
        }
    }

    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
