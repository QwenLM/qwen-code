import { appendFileSync } from "node:fs";

const writeLog = (message: string) => {
	if (process.env.LOG_FILE) {
		const logfile = process.env.LOG_FILE;
		const timestamp = new Date().toISOString();
		const levelStr = "INFO";
		const logMessage = `[${timestamp}] ${levelStr} ${message}`;
		appendFileSync(logfile, logMessage + "\n");
	}

	console.error(message);
};

export const trace = (message: string) => {
	writeLog(message);
};

export const error = (message: string) => {
	writeLog(message);
};
