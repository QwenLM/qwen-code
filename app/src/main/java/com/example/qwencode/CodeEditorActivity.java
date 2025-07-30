package com.example.qwencode;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import io.github.kbiakov.codeview.CodeView;
import io.github.kbiakov.codeview.adapters.Options;
import io.github.kbiakov.codeview.highlight.ColorTheme;

public class CodeEditorActivity extends AppCompatActivity {

    public static final String EXTRA_CODE = "extra_code";
    public static final String EXTRA_LANGUAGE = "extra_language";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_code_editor);

        CodeView codeView = findViewById(R.id.code_view);

        String code = getIntent().getStringExtra(EXTRA_CODE);
        String language = getIntent().getStringExtra(EXTRA_LANGUAGE);

        if (code == null) {
            code = "// No code provided";
        }
        if (language == null) {
            language = "java"; // Default to java
        }

        codeView.setOptions(Options.Default.get(this)
                .withLanguage(language)
                .withCode(code)
                .withTheme(ColorTheme.DEFAULT));
    }
}
