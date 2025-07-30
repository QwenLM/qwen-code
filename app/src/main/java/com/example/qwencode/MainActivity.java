package com.example.qwencode;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private RecyclerView recyclerView;
    private TextView emptyView;
    private EditText editText;
    private Button sendButton;
    private ImageButton attachButton;
    private ImageButton browseButton;
    private ChatAdapter chatAdapter;
    private List<ChatMessage> chatMessages;
    private QwenApiClient qwenApiClient;
    private String chatId = null;
    private String currentParentId = null;
    private final ExecutorService executorService = Executors.newSingleThreadExecutor();
    private final List<QwenApiClient.UploadedFile> attachedFiles = new ArrayList<>();

    private final ActivityResultLauncher<String> filePickerLauncher = registerForActivityResult(
            new ActivityResultContracts.GetContent(),
            this::onFileSelected
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        recyclerView = findViewById(R.id.recyclerView);
        emptyView = findViewById(R.id.emptyView);
        editText = findViewById(R.id.editText);
        sendButton = findViewById(R.id.sendButton);
        attachButton = findViewById(R.id.attachButton);
        browseButton = findViewById(R.id.browseButton);

        chatMessages = new ArrayList<>();
        chatAdapter = new ChatAdapter(chatMessages);
        recyclerView.setLayoutManager(new LinearLayoutManager(this));
        recyclerView.setAdapter(chatAdapter);

        qwenApiClient = new QwenApiClient();

        sendButton.setOnClickListener(v -> {
            String messageText = editText.getText().toString().trim();
            if (!messageText.isEmpty() || !attachedFiles.isEmpty()) {
                sendMessage(messageText);
                editText.setText("");
            }
        });

        attachButton.setOnClickListener(v -> filePickerLauncher.launch("*/*"));
        browseButton.setOnClickListener(v -> {
            Intent intent = new Intent(MainActivity.this, FileListActivity.class);
            startActivity(intent);
        });

        updateEmptyViewVisibility();
    }

    private void sendMessage(String messageText) {
        updateEmptyViewVisibility();
        // Add user message to UI
        ChatMessage userMessage = new ChatMessage(messageText, ChatMessage.Type.USER);
        chatMessages.add(userMessage);
        chatAdapter.notifyItemInserted(chatMessages.size() - 1);
        recyclerView.scrollToPosition(chatMessages.size() - 1);

        // Add a placeholder for the bot's response
        ChatMessage botMessage = new ChatMessage("", ChatMessage.Type.BOT);
        chatMessages.add(botMessage);
        int botMessagePosition = chatMessages.size() - 1;
        chatAdapter.notifyItemInserted(botMessagePosition);
        recyclerView.scrollToPosition(botMessagePosition);

        final List<QwenApiClient.UploadedFile> filesToSend = new ArrayList<>(attachedFiles);
        attachedFiles.clear(); // Clear for the next message

        executorService.execute(() -> {
            try {
                if (chatId == null) {
                    chatId = qwenApiClient.newChat("New Chat", "qwen3-coder-plus");
                }

                QwenApiClient.CompletionsRequest request = new QwenApiClient.CompletionsRequest(
                        chatId,
                        "qwen3-coder-plus",
                        currentParentId,
                        messageText
                );
                // Attach files to the message
                if (!filesToSend.isEmpty()) {
                    request.messages[0].files = filesToSend;
                }


                qwenApiClient.getCompletions(request, new QwenApiClient.CompletionCallback() {
                    @Override
                    public void onResponse(String content) {
                        runOnUiThread(() -> {
                            botMessage.appendMessage(content);
                            chatAdapter.notifyItemChanged(botMessagePosition);
                        });
                    }

                    @Override
                    public void onError(Exception e) {
                        e.printStackTrace();
                        runOnUiThread(() -> Toast.makeText(MainActivity.this, "Error: " + e.getMessage(), Toast.LENGTH_LONG).show());
                    }

                    @Override
                    public void onComplete() {
                        // Handle completion
                    }
                });

            } catch (IOException e) {
                e.printStackTrace();
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Error: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    private void onFileSelected(Uri uri) {
        if (uri == null) return;

        executorService.execute(() -> {
            try {
                String filename = getFileName(uri);
                byte[] fileBytes = getFileBytes(uri);
                if (fileBytes == null) throw new IOException("Could not read file");

                // 1. Get STS Token
                QwenApiClient.GetStsTokenResponse stsResponse = qwenApiClient.getStsToken(filename, fileBytes.length);

                // 2. Upload file
                // As noted before, this part will likely fail with 403 due to complex signing.
                // We proceed to demonstrate the flow.
                qwenApiClient.uploadFile(stsResponse.data, fileBytes, getContentResolver().getType(uri));

                // 3. Add to list of files to be sent with the next message
                QwenApiClient.UploadedFile uploadedFile = new QwenApiClient.UploadedFile(
                        stsResponse.data.file_id,
                        filename,
                        stsResponse.data.file_url
                );
                attachedFiles.add(uploadedFile);

                runOnUiThread(() -> Toast.makeText(this, filename + " attached.", Toast.LENGTH_SHORT).show());

            } catch (IOException e) {
                e.printStackTrace();
                runOnUiThread(() -> Toast.makeText(this, "File upload failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    // Helper to get filename from URI
    private String getFileName(Uri uri) {
        String result = null;
        if (uri.getScheme().equals("content")) {
            try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if(index >=0)
                        result = cursor.getString(index);
                }
            }
        }
        if (result == null) {
            result = uri.getPath();
            int cut = result.lastIndexOf('/');
            if (cut != -1) {
                result = result.substring(cut + 1);
            }
        }
        return result;
    }

    // Helper to get byte array from URI
    private byte[] getFileBytes(Uri uri) throws IOException {
        InputStream inputStream = getContentResolver().openInputStream(uri);
        if (inputStream == null) return null;
        ByteArrayOutputStream byteBuffer = new ByteArrayOutputStream();
        int bufferSize = 1024;
        byte[] buffer = new byte[bufferSize];

        int len;
        while ((len = inputStream.read(buffer)) != -1) {
            byteBuffer.write(buffer, 0, len);
        }
        return byteBuffer.toByteArray();
    }

    private void updateEmptyViewVisibility() {
        if (chatMessages.isEmpty()) {
            recyclerView.setVisibility(View.GONE);
            emptyView.setVisibility(View.VISIBLE);
        } else {
            recyclerView.setVisibility(View.VISIBLE);
            emptyView.setVisibility(View.GONE);
        }
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull android.view.MenuItem item) {
        if (item.getItemId() == R.id.action_clear_chat) {
            chatMessages.clear();
            chatAdapter.notifyDataSetChanged();
            updateEmptyViewVisibility();
            chatId = null;
            currentParentId = null;
            Toast.makeText(this, "Chat cleared", Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
