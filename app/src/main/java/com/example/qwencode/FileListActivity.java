package com.example.qwencode;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Environment;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class FileListActivity extends AppCompatActivity implements FileAdapter.OnFileClickListener {

    private static final int PERMISSION_REQUEST_CODE = 100;
    private RecyclerView fileRecyclerView;
    private FileAdapter fileAdapter;
    private List<File> fileList;
    private File currentDirectory;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_file_list);

        fileRecyclerView = findViewById(R.id.fileRecyclerView);
        fileRecyclerView.setLayoutManager(new LinearLayoutManager(this));
        fileList = new ArrayList<>();
        fileAdapter = new FileAdapter(fileList, this);
        fileRecyclerView.setAdapter(fileAdapter);

        if (checkPermission()) {
            loadInitialDirectory();
        } else {
            requestPermission();
        }
    }

    private boolean checkPermission() {
        int result = ContextCompat.checkSelfPermission(getApplicationContext(), Manifest.permission.READ_EXTERNAL_STORAGE);
        return result == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermission() {
        ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, PERMISSION_REQUEST_CODE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                loadInitialDirectory();
            } else {
                Toast.makeText(this, "Permission Denied", Toast.LENGTH_SHORT).show();
                finish();
            }
        }
    }

    private void loadInitialDirectory() {
        currentDirectory = Environment.getExternalStorageDirectory();
        loadDirectory(currentDirectory);
    }

    private void loadDirectory(File directory) {
        currentDirectory = directory;
        setTitle(directory.getName());
        fileList.clear();

        File[] files = directory.listFiles();
        if (files != null) {
            // Sort files: directories first, then by name
            Arrays.sort(files, (f1, f2) -> {
                if (f1.isDirectory() && !f2.isDirectory()) return -1;
                if (!f1.isDirectory() && f2.isDirectory()) return 1;
                return f1.getName().compareToIgnoreCase(f2.getName());
            });
            Collections.addAll(fileList, files);
        }

        // Add ".." to go up to the parent directory
        if (directory.getParentFile() != null) {
            fileList.add(0, directory.getParentFile());
        }

        fileAdapter.notifyDataSetChanged();
    }

    @Override
    public void onFileClick(File file) {
        if (file.isDirectory()) {
            loadDirectory(file);
        } else {
            // It's a file, open it in the code editor
            try {
                String content = readFileContent(file);
                Intent intent = new Intent(this, CodeEditorActivity.class);
                intent.putExtra(CodeEditorActivity.EXTRA_CODE, content);
                intent.putExtra(CodeEditorActivity.EXTRA_LANGUAGE, getLanguageFromFile(file));
                startActivity(intent);
            } catch (IOException e) {
                e.printStackTrace();
                Toast.makeText(this, "Error reading file", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private String readFileContent(File file) throws IOException {
        FileInputStream fis = new FileInputStream(file);
        byte[] data = new byte[(int) file.length()];
        fis.read(data);
        fis.close();
        return new String(data, StandardCharsets.UTF_8);
    }

    private String getLanguageFromFile(File file) {
        String name = file.getName();
        if (name.endsWith(".java")) return "java";
        if (name.endsWith(".js")) return "javascript";
        if (name.endsWith(".kt")) return "kotlin";
        if (name.endsWith(".xml")) return "xml";
        if (name.endsWith(".html")) return "html";
        if (name.endsWith(".css")) return "css";
        if (name.endsWith(".py")) return "python";
        return "plaintext"; // default
    }

    @Override
    public void onBackPressed() {
        if (currentDirectory != null && currentDirectory.getParentFile() != null && !currentDirectory.equals(Environment.getExternalStorageDirectory())) {
            loadDirectory(currentDirectory.getParentFile());
        } else {
            super.onBackPressed();
        }
    }
}
