# RARE VS Code startup

Open `RARE035_final` as a VS Code folder/workspace. VS Code is configured to run `START_RARE.cmd` automatically when the folder opens.

`START_RARE.cmd` creates `.venv` when it does not exist, installs the required Python packages when they are missing, and starts RARE. The `.venv` is deliberately not stored in the release ZIP because it is machine-specific.

On the first opening, VS Code may ask whether automatic tasks from this folder are allowed. Choose **Allow**. After that, opening the RARE folder starts the bootstrap task automatically.
