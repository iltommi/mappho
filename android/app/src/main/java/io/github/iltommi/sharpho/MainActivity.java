package io.github.iltommi.sharpho;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IntentPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
