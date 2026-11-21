### Fixed

- Stop the app from freezing after each whole chat save on a large database. The cleanup of replaced
  chat snapshots read every saved event of the chat and scanned the whole activity table each time;
  it now reads only the events since the last cleanup and removes activity rows by their key.
