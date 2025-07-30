package com.codex.agent;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import io.github.kbiakov.codeview.CodeView;
import io.github.kbiakov.codeview.adapters.Options;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

import io.github.kbiakov.codeview.CodeView;
import io.github.kbiakov.codeview.adapters.Options;
import io.github.kbiakov.codeview.highlight.ColorTheme;

public class CodeEditorActivity extends AppCompatActivity {

    public static final String EXTRA_CODE = "extra_code";
    public static final String EXTRA_LANGUAGE = "extra_language";
    public static final String EXTRA_FILE_PATH = "extra_file_path";
    private static final int WRITE_PERMISSION_REQUEST_CODE = 101;


    private CodeView codeView;
    private Button editButton;
    private Button saveButton;
    private String filePath;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_code_editor);

        codeView = findViewById(R.id.code_view);
        editButton = findViewById(R.id.editButton);
        saveButton = findViewById(R.id.saveButton);

        String code = getIntent().getStringExtra(EXTRA_CODE);
        String language = getIntent().getStringExtra(EXTRA_LANGUAGE);
        filePath = getIntent().getStringExtra(EXTRA_FILE_PATH);

        if (code == null) {
            code = "// No code provided";
        }
        if (language == null) {
            language = "java"; // Default to java
        }

        codeView.setOptions(Options.Default.get(this)
                .withLanguage(language)
                .withCode(code)
                .withTheme(ColorTheme.DEFAULT)
                .withEditor(false)); // Initially not editable

        editButton.setOnClickListener(v -> {
            codeView.getOptions().setEditor(true);
            codeView.updateOptions();
            editButton.setVisibility(View.GONE);
            saveButton.setVisibility(View.VISIBLE);
        });

        saveButton.setOnClickListener(v -> {
            if (checkPermission()) {
                saveCode();
            } else {
                requestPermission();
            }
        });
    }

    private void saveCode() {
        if (filePath == null) {
            Toast.makeText(this, "Cannot save, file path not provided.", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            String updatedCode = codeView.getCode();
            FileOutputStream fos = new FileOutputStream(new File(filePath));
            fos.write(updatedCode.getBytes());
            fos.close();
            Toast.makeText(this, "File saved successfully", Toast.LENGTH_SHORT).show();
            codeView.getOptions().setEditor(false);
            codeView.updateOptions();
            editButton.setVisibility(View.VISIBLE);
            saveButton.setVisibility(View.GONE);
        } catch (IOException e) {
            e.printStackTrace();
            Toast.makeText(this, "Error saving file", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean checkPermission() {
        int result = ContextCompat.checkSelfPermission(getApplicationContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE);
        return result == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermission() {
        ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, WRITE_PERMISSION_REQUEST_CODE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == WRITE_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                saveCode();
            } else {
                Toast.makeText(this, "Write Permission Denied", Toast.LENGTH_SHORT).show();
            }
        }
    }
}
