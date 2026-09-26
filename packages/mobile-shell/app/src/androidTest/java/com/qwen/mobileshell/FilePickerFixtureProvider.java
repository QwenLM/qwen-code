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
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

// The test APK's separate provider process cannot load the target APK's Kotlin runtime.
public class FilePickerFixtureProvider extends ContentProvider {
    private static final String TARGET = "com.qwen.mobileshell";
    public static final Uri BASE_URI = Uri.parse("content://com.qwen.mobileshell.test.picker");

    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        Context owner = getContext();
        if (owner == null) throw new IllegalStateException("Fixture provider is not attached");
        try {
            if (Binder.getCallingUid() != owner.getPackageManager().getApplicationInfo(TARGET, 0).uid) {
                throw new SecurityException("Only the target app can change fixture grants");
            }
        } catch (PackageManager.NameNotFoundException error) {
            throw new SecurityException("Target app is not installed", error);
        }
        long identity = Binder.clearCallingIdentity();
        try {
            if ("grant".equals(method)) {
                owner.grantUriPermission(TARGET, uri(Integer.parseInt(arg)), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else if ("reset".equals(method)) {
                for (int index = 0; index <= 100; index++) {
                    owner.revokeUriPermission(TARGET, uri(index), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    File file = new File(owner.getCacheDir(), "picker-fixture-" + index + ".txt");
                    if (file.exists() && !file.delete()) throw new IllegalStateException("Cannot remove fixture file");
                }
            } else {
                throw new IllegalArgumentException("Unknown fixture operation");
            }
        } finally {
            Binder.restoreCallingIdentity(identity);
        }
        return Bundle.EMPTY;
    }

    @Override public ParcelFileDescriptor openFile(Uri selected, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new IllegalArgumentException("Fixture is read-only");
        int index = Integer.parseInt(selected.getLastPathSegment());
        if (!selected.equals(uri(index))) throw new IllegalArgumentException("Unknown fixture URI");
        Context owner = getContext();
        if (owner == null) throw new IllegalStateException("Fixture provider is not attached");
        File file = new File(owner.getCacheDir(), "picker-fixture-" + index + ".txt");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(contents(index));
        } catch (IOException error) {
            FileNotFoundException failure = new FileNotFoundException("Cannot write fixture file");
            failure.initCause(error);
            throw failure;
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) { return "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }

    public static Uri uri(int index) {
        if (index < 0 || index > 100) throw new IllegalArgumentException("Unknown fixture index");
        return BASE_URI.buildUpon().appendPath(Integer.toString(index)).build();
    }

    public static byte[] contents(int index) {
        return ("Synthetic picker document " + index + "\n").getBytes(StandardCharsets.UTF_8);
    }
}
