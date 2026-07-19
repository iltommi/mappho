package io.github.iltommi.mappho;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IntentPlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
