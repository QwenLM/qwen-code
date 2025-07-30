package com.codex.agent;

import com.google.gson.Gson;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class QwenApiClient {

    private static final String BASE_URL = "https://chat.qwen.ai/api/v2/";
    private static final OkHttpClient client = new OkHttpClient();
    private static final Gson gson = new Gson();
    public static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    // Hardcoded headers from qwen_thinking_search.txt
    private static final String COOKIE = "_gcl_au=1.1.1766988768.1752579263; _bl_uid=nXm6qd3q4zpg6tgm02909kvmFUpm; acw_tc=0a03e54317532565292955177e493bd17cb6ab0297793d17257e4afc7bf42b; x-ap=ap-southeast-1; token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjhiYjQ1NjVmLTk3NjUtNDQwNi04OWQ5LTI3NmExMTIxMjBkNiIsImxhc3RfcGFzc3dvcmRfY2hhbmdlIjoxNzUwNjYwODczLCJleHAiOjE3NTU4NDg1NDh9.pb0IybY9tQkriqMUOos72FKtZM3G4p1_aDzwqqh5zX4; tfstk=g26ZgsaVhdo2fDL9s99qzj0MwtJ9pKzS_tTXmijDfFYgWt92meSq51sfmKy2-dAA1ET6uKSAzka7F8sOXKpgPzw7wJZtXLHiIn0Xxpxv3h4mOM1lXKp0RbHESRSOW-xr1Gv0YpxXDjvDjhm3Yn-yoKYMi2cHqevDnIDmx2xJqhDDmKqFxeKXnEbDskRHJnxt_a_0zhdgx9OWGMnuVCYljekmEV-9sUeJ5xDfIIBvrGVxnxXebCBHdIJMEK5c2sJDLrlvo9LVIsSUJfYGB9IW5ta-GFjCtBX99mZ9o1jCLQ63qX8fw9W26TzI3E55A9RFOgWqkHXCttBYHjAMvH87Yko6Tuw5pVSFyjhv6C-ePkcoMjdMvH87YklxMCyeYUZnZ; isg=BP7-CDNoGikWBk775LCGxejTTxZAP8K5TbnYJKgHacE8S5klEs5CyL4txkkhzbrR; ssxmod_itna=eq0xcDgCGQYDq4e9igDmhxnD3q7u40dGM9Deq7tdGcD8Ox0PGOzojD5DU2Yz2Ak52qqGRmgKD/KQCqDy7xA3DTx+ajQq5nxvqq35mCxteqDPLwwweCngAOnBKmgY8nUTXUZgw0=KqeDIDY=IDAtD0qDi+DDgDA=DjwDD7qe4DxDADB=bFeDLDi3eVQTDtw0=ieGwDAY4BOhwDYEKwGnxwDDS4QTIieDf9DG2DD=IRWRbqCwTDOxgCKe589bS3Th0BR3VRYIjSYq4SgIA5H8D8+lxm9YUqocQdabWwpEGsERk7wUgILQCFBQ/GD+xe7r5l05oQKiAGxgkVuDhi+YiDD; ssxmod_itna2=eq0xcDgCGQYDq4e9igDmhxnD3q7u40dGM9Deq7tdGcD8Ox0PGOzojD5DU2Yz2Ak52qqGRmxeGIDgDn6Pq+Ee03t1Q6TnxtwxGXxT5W12cxqQj6SG+THGZOQ412fzxk4BtN=FjAO01cDxOPy4S2vsrri5BxIH1iD8Bj01z27Wt4g1aEyaODFW2DAq26osz+i53rvxinaO+Si+6/er3aMigjTNVlTQiWMbqOmq4D";
    private static final String AUTHORIZATION = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjhiYjQ1NjVmLTk3NjUtNDQwNi04OWQ5LTI3NmExMTIxMjBkNiIsImxhc3RfcGFzc3dvcmRfY2hhbmdlIjoxNzUwNjYwODczLCJleHAiOjE3NTU4NDg1D0h9.pb0IybY9tQkriqMUOos72FKtZM3G4p1_aDzwqqh5zX4";
    private static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 12; itel A662LM) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36";

    // POJO for New Chat Request
    private static class NewChatRequest {
        String title;
        String[] models;
        String chat_mode;
        String chat_type;
        long timestamp;

        NewChatRequest(String title, String model) {
            this.title = title;
            this.models = new String[]{model};
            this.chat_mode = "normal";
            this.chat_type = "t2t";
            this.timestamp = System.currentTimeMillis();
        }
    }

    // POJO for New Chat Response
    private static class NewChatResponse {
        boolean success;
        String request_id;
        Data data;

        static class Data {
            String id;
        }
    }

    public String newChat(String title, String model) throws IOException {
        NewChatRequest newChatRequest = new NewChatRequest(title, model);
        String json = gson.toJson(newChatRequest);
        RequestBody body = RequestBody.create(json, JSON);

        Request request = new Request.Builder()
                .url(BASE_URL + "chats/new")
                .post(body)
                .addHeader("Cookie", COOKIE)
                .addHeader("Authorization", AUTHORIZATION)
                .addHeader("User-Agent", USER_AGENT)
                .addHeader("Origin", "https://chat.qwen.ai")
                .addHeader("Referer", "https://chat.qwen.ai/")
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("Unexpected code " + response);

            NewChatResponse newChatResponse = gson.fromJson(response.body().charStream(), NewChatResponse.class);
            if (newChatResponse != null && newChatResponse.success) {
                return newChatResponse.data.id;
            } else {
                throw new IOException("Failed to create new chat");
            }
        }
    }

    // --- Completion Method and related classes ---

    public interface CompletionCallback {
        void onResponse(String content);
        void onError(Exception e);
        void onComplete();
    }

    // POJOs for Completion Request
    public static class CompletionsRequest {
        boolean stream = true;
        boolean incremental_output = true;
        String chat_id;
        String model;
        String parent_id;
        Message[] messages;
        long timestamp;

        public CompletionsRequest(String chatId, String model, String parentId, String userMessage) {
            this.chat_id = chatId;
            this.model = model;
            this.parent_id = parentId;
            this.messages = new Message[]{new Message("user", userMessage)};
            this.timestamp = System.currentTimeMillis();
        }
    }

    public static class Message {
        String role;
        String content;
        List<UploadedFile> files;

        // Constructor for text-only messages
        public Message(String role, String content) {
            this.role = role;
            this.content = content;
            this.files = new ArrayList<>();
        }

        // Constructor for messages with files
        public Message(String role, String content, List<UploadedFile> files) {
            this.role = role;
            this.content = content;
            this.files = files;
        }
    }

    public static class UploadedFile {
        String id;
        String name;
        String url;
        String file_type;
        // Add other fields as needed from the log
        public UploadedFile(String id, String name, String url) {
            this.id = id;
            this.name = name;
            this.url = url;
            this.file_type = "text/plain"; // Or determine dynamically
        }
    }

    // POJO for Completion Response (parsing the "data:" lines)
    private static class CompletionResponse {
        Choice[] choices;
        static class Choice {
            Delta delta;
        }
        static class Delta {
            String content;
            String status;
        }
    }


    public void getCompletions(CompletionsRequest completionsRequest, CompletionCallback callback) {
        String json = gson.toJson(completionsRequest);
        RequestBody body = RequestBody.create(json, JSON);

        Request request = new Request.Builder()
                .url(BASE_URL + "chat/completions?chat_id=" + completionsRequest.chat_id)
                .post(body)
                .addHeader("Cookie", COOKIE)
                .addHeader("Authorization", AUTHORIZATION)
                .addHeader("User-Agent", USER_AGENT)
                .addHeader("Origin", "https://chat.qwen.ai")
                .addHeader("Referer", "https://chat.qwen.ai/c/" + completionsRequest.chat_id)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "text/event-stream") // Expect a stream
                .addHeader("x-accel-buffering", "no")
                .build();

        client.newCall(request).enqueue(new okhttp3.Callback() {
            @Override
            public void onFailure(okhttp3.Call call, IOException e) {
                callback.onError(e);
            }

            @Override
            public void onResponse(okhttp3.Call call, Response response) throws IOException {
                if (!response.isSuccessful()) {
                    callback.onError(new IOException("Unexpected code " + response));
                    return;
                }

                try (okhttp3.ResponseBody responseBody = response.body()) {
                    if (responseBody == null) {
                        callback.onError(new IOException("Empty response body"));
                        return;
                    }

                    java.io.InputStream inputStream = responseBody.byteStream();
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(inputStream));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.startsWith("data: ")) {
                            String dataJson = line.substring(6);
                            if (dataJson.trim().isEmpty()) continue;

                            try {
                                CompletionResponse completionResponse = gson.fromJson(dataJson, CompletionResponse.class);
                                if (completionResponse != null && completionResponse.choices != null && completionResponse.choices.length > 0) {
                                    Delta delta = completionResponse.choices[0].delta;
                                    if (delta != null) {
                                        if (delta.content != null && !delta.content.isEmpty()) {
                                            callback.onResponse(delta.content);
                                        }
                                        if ("finished".equals(delta.status)) {
                                            break; // Exit loop on finished status
                                        }
                                    }
                                }
                            } catch (com.google.gson.JsonSyntaxException e) {
                                // Ignore malformed JSON, e.g., the initial `response.created` message
                            }
                        }
                    }
                } catch (IOException e) {
                    callback.onError(e);
                } finally {
                    callback.onComplete();
                }
            }
        });
    }

    // --- File Uploading Methods and related classes ---

    private static class GetStsTokenRequest {
        String filename;
        long filesize;
        String filetype = "file";

        GetStsTokenRequest(String filename, long filesize) {
            this.filename = filename;
            this.filesize = filesize;
        }
    }

    public static class GetStsTokenResponse {
        public boolean success;
        public String request_id;
        public StsTokenData data;

        public static class StsTokenData {
            public String access_key_id;
            public String access_key_secret;
            public String security_token;
            public String file_url;
            public String file_path;
            public String file_id;
            public String bucketname;
            public String region;
            public String endpoint;
        }
    }

    public GetStsTokenResponse getStsToken(String filename, long filesize) throws IOException {
        GetStsTokenRequest getStsTokenRequest = new GetStsTokenRequest(filename, filesize);
        String json = gson.toJson(getStsTokenRequest);
        RequestBody body = RequestBody.create(json, JSON);

        Request request = new Request.Builder()
                .url(BASE_URL + "files/getstsToken")
                .post(body)
                .addHeader("Cookie", COOKIE)
                .addHeader("Authorization", AUTHORIZATION)
                .addHeader("User-Agent", USER_AGENT)
                .addHeader("Origin", "https://chat.qwen.ai")
                .addHeader("Referer", "https://chat.qwen.ai/")
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("Unexpected code " + response);

            GetStsTokenResponse stsResponse = gson.fromJson(response.body().charStream(), GetStsTokenResponse.class);
            if (stsResponse != null && stsResponse.success) {
                return stsResponse;
            } else {
                throw new IOException("Failed to get STS token");
            }
        }
    }

    public void uploadFile(GetStsTokenResponse.StsTokenData stsData, byte[] fileBytes, String contentType) throws IOException {
        RequestBody body = RequestBody.create(fileBytes, MediaType.get(contentType));

        // NOTE: The Authorization header is a complex, time-sensitive signature.
        // Replicating it perfectly without the Aliyun SDK is very difficult.
        // For this educational project, we are using a static placeholder from the logs.
        // This will likely fail against the live server, but it demonstrates the API flow.
        String authHeader = "OSS4-HMAC-SHA256 Credential=" + stsData.access_key_id + "/20250723/ap-southeast-1/oss/aliyun_v4_request,Signature=83b99260b7504ee443683ba60f9bbd52f50bff6938b10112cd99c31836a6a0b8";

        Request request = new Request.Builder()
                .url("https://" + stsData.endpoint + "/" + stsData.file_path)
                .put(body)
                .addHeader("Authorization", authHeader)
                .addHeader("x-oss-security-token", stsData.security_token)
                .addHeader("x-oss-date", "20250723T080635Z") // This should be dynamic
                .addHeader("Content-Type", contentType)
                .build();

        try (Response response = client.newCall(request).execute()) {
            // A successful PUT to OSS often returns 200 OK with an empty body.
            if (!response.isSuccessful()) {
                throw new IOException("Failed to upload file: " + response);
            }
        }
    }
}
