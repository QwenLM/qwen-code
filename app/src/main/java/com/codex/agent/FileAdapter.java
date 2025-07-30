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

public class FileAdapter extends RecyclerView.Adapter<FileAdapter.FileViewHolder> {

    private List<File> files;
    private OnFileClickListener listener;

    public interface OnFileClickListener {
        void onFileClick(File file);
    }

    public FileAdapter(List<File> files, OnFileClickListener listener) {
        this.files = files;
        this.listener = listener;
    }

    @NonNull
    @Override
    public FileViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_file, parent, false);
        return new FileViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull FileViewHolder holder, int position) {
        File file = files.get(position);
        holder.bind(file, listener);
    }

    @Override
    public int getItemCount() {
        return files.size();
    }

    static class FileViewHolder extends RecyclerView.ViewHolder {
        ImageView fileIcon;
        TextView fileName;

        FileViewHolder(View itemView) {
            super(itemView);
            fileIcon = itemView.findViewById(R.id.fileIcon);
            fileName = itemView.findViewById(R.id.fileName);
        }

        void bind(final File file, final OnFileClickListener listener) {
            fileName.setText(file.getName());
            if (file.isDirectory()) {
                fileIcon.setImageResource(R.drawable.ic_folder);
            } else {
                fileIcon.setImageResource(R.drawable.ic_file);
            }
            itemView.setOnClickListener(v -> listener.onFileClick(file));
        }
    }
}
