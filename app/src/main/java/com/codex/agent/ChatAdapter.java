package com.codex.agent;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;
import java.io.File;
import java.util.List;

public class ChatAdapter extends RecyclerView.Adapter<RecyclerView.ViewHolder> {

    private static final int VIEW_TYPE_USER = 1;
    private static final int VIEW_TYPE_BOT = 2;
    private static final int VIEW_TYPE_ERROR = 3;

    private List<ChatMessage> messages;

    public ChatAdapter(List<ChatMessage> messages) {
        this.messages = messages;
    }

    @Override
    public int getItemViewType(int position) {
        ChatMessage message = messages.get(position);
        switch (message.getType()) {
            case USER:
                return VIEW_TYPE_USER;
            case BOT:
                return VIEW_TYPE_BOT;
            case ERROR:
                return VIEW_TYPE_ERROR;
            default:
                return -1;
        }
    }

    @NonNull
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        switch (viewType) {
            case VIEW_TYPE_USER:
                View userView = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_chat_message_user, parent, false);
                return new UserMessageViewHolder(userView);
            case VIEW_TYPE_BOT:
                View botView = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_chat_message_bot, parent, false);
                return new BotMessageViewHolder(botView);
            case VIEW_TYPE_ERROR:
                View errorView = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_chat_message_error, parent, false);
                return new ErrorViewHolder(errorView);
            default:
                throw new IllegalArgumentException("Invalid view type");
        }
    }

    @Override
    public void onBindViewHolder(@NonNull RecyclerView.ViewHolder holder, int position) {
        ChatMessage message = messages.get(position);
        switch (holder.getItemViewType()) {
            case VIEW_TYPE_USER:
                ((UserMessageViewHolder) holder).bind(message);
                break;
            case VIEW_TYPE_BOT:
                ((BotMessageViewHolder) holder).bind(message);
                break;
            case VIEW_TYPE_ERROR:
                ((ErrorViewHolder) holder).bind(message);
                break;
        }
    }

    @Override
    public int getItemCount() {
        return messages.size();
    }

    // ViewHolder for user messages
    private static class UserMessageViewHolder extends RecyclerView.ViewHolder {
        TextView messageTextView;

        UserMessageViewHolder(View itemView) {
            super(itemView);
            messageTextView = itemView.findViewById(R.id.messageTextView);
        }

        void bind(ChatMessage message) {
            messageTextView.setText(message.getMessage());
        }
    }

    // ViewHolder for bot messages
    private static class BotMessageViewHolder extends RecyclerView.ViewHolder {
        TextView messageTextView;

        BotMessageViewHolder(View itemView) {
            super(itemView);
            messageTextView = itemView.findViewById(R.id.messageTextView);
        }

        void bind(ChatMessage message) {
            messageTextView.setText(message.getMessage());
        }
    }

    // ViewHolder for error messages
    private static class ErrorViewHolder extends RecyclerView.ViewHolder {
        TextView messageTextView;

        ErrorViewHolder(View itemView) {
            super(itemView);
            messageTextView = itemView.findViewById(R.id.messageTextView);
        }

        void bind(ChatMessage message) {
            messageTextView.setText(message.getMessage());
        }
    }
}
