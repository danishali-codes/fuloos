package dev.danishali.fuloos;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.danishali.fuloos.sms.FuloosSmsPlugin;
import dev.danishali.fuloos.sms.SmsNotificationHelper;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FuloosSmsPlugin.class);
        super.onCreate(savedInstanceState);
        SmsNotificationHelper.INSTANCE.ensureChannels(this);
        FuloosSmsPlugin.Companion.handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        FuloosSmsPlugin.Companion.handleIntent(intent);
    }
}
